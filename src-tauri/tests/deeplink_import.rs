use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use cc_switch_lib::{
    get_claude_desktop_default_routes, import_provider_from_deeplink, parse_deeplink_url,
    update_settings, AppSettings, AppState, AppType, Database, Provider, ProviderService,
};
use serde_json::{json, Value};
use url::Url;

#[path = "support.rs"]
mod support;
use support::{ensure_test_home, reset_test_fs, test_mutex};

const DESKTOP_APP: &str = "claude-desktop";

fn desktop_fixture_dirs(home: &Path) -> Vec<PathBuf> {
    vec![
        home.join("Library")
            .join("Application Support")
            .join("Claude"),
        home.join("Library")
            .join("Application Support")
            .join("Claude-3p"),
        home.join("AppData").join("Local").join("Claude"),
        home.join("AppData").join("Local").join("Claude-3p"),
    ]
}

fn clean_desktop_fixtures(home: &Path) {
    for path in desktop_fixture_dirs(home) {
        if path.exists() {
            fs::remove_dir_all(&path).expect("clean isolated Claude Desktop fixture");
        }
    }
}

#[cfg(target_os = "macos")]
fn desktop_config_dirs(home: &Path) -> (PathBuf, PathBuf) {
    let app_support = home.join("Library").join("Application Support");
    (app_support.join("Claude"), app_support.join("Claude-3p"))
}

#[cfg(windows)]
fn desktop_config_dirs(home: &Path) -> (PathBuf, PathBuf) {
    let local_app_data = home.join("AppData").join("Local");
    (
        local_app_data.join("Claude"),
        local_app_data.join("Claude-3p"),
    )
}

#[cfg(not(any(target_os = "macos", windows)))]
fn desktop_config_dirs(home: &Path) -> (PathBuf, PathBuf) {
    let app_support = home.join("Library").join("Application Support");
    (app_support.join("Claude"), app_support.join("Claude-3p"))
}

fn collect_tree(root: &Path, path: &Path, files: &mut Vec<(PathBuf, Vec<u8>)>) {
    if !path.exists() {
        return;
    }
    for entry in fs::read_dir(path).expect("read isolated Desktop fixture directory") {
        let path = entry.expect("read Desktop fixture entry").path();
        if path.is_dir() {
            collect_tree(root, &path, files);
        } else {
            files.push((
                path.strip_prefix(root)
                    .expect("Desktop fixture remains below its root")
                    .to_path_buf(),
                fs::read(&path).expect("read isolated Desktop fixture file"),
            ));
        }
    }
}

fn snapshot_desktop_files(home: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    let (normal, threep) = desktop_config_dirs(home);
    let mut files = Vec::new();
    collect_tree(&normal, &normal, &mut files);
    let normal_len = files.len();
    for (path, _) in &mut files {
        *path = PathBuf::from("normal").join(&*path);
    }
    collect_tree(&threep, &threep, &mut files);
    for (path, _) in &mut files[normal_len..] {
        *path = PathBuf::from("threep").join(&*path);
    }
    files.sort_by(|left, right| left.0.cmp(&right.0));
    files
}

fn desktop_profile(home: &Path) -> Value {
    let (_, threep) = desktop_config_dirs(home);
    let library = threep.join("configLibrary");
    let mut profiles = fs::read_dir(&library)
        .expect("read isolated Desktop config library")
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension().and_then(|value| value.to_str()) == Some("json")
                && path.file_name().and_then(|value| value.to_str()) != Some("_meta.json")
        })
        .collect::<Vec<_>>();
    profiles.sort();
    assert_eq!(profiles.len(), 1, "exactly one managed Desktop profile");
    serde_json::from_slice(&fs::read(&profiles[0]).expect("read Desktop profile"))
        .expect("parse Desktop profile")
}

fn provider_url(app: &str, name: &str, extra: &[(&str, &str)]) -> String {
    let mut url = Url::parse("ccswitch://v1/import").expect("base deeplink URL");
    {
        let mut query = url.query_pairs_mut();
        query
            .append_pair("resource", "provider")
            .append_pair("app", app)
            .append_pair("name", name);
        for (key, value) in extra {
            query.append_pair(key, value);
        }
    }
    url.to_string()
}

fn import_url(state: &AppState, url: &str) -> String {
    let request = parse_deeplink_url(url).expect("parse provider deeplink");
    import_provider_from_deeplink(state, request).expect("import provider deeplink")
}

fn provider_meta_json(provider: &cc_switch_lib::Provider) -> Value {
    serde_json::to_value(provider.meta.as_ref().expect("Desktop provider meta"))
        .expect("serialize Desktop provider meta")
}

fn desktop_settings_path(home: &Path) -> PathBuf {
    home.join(".cc-switch").join("settings.json")
}

#[test]
fn deeplink_import_claude_provider_persists_to_db() {
    let _guard = test_mutex().lock().expect("acquire test mutex");
    reset_test_fs();
    let _home = ensure_test_home();

    let url = "ccswitch://v1/import?resource=provider&app=claude&name=DeepLink%20Claude&homepage=https%3A%2F%2Fexample.com&endpoint=https%3A%2F%2Fapi.example.com%2Fv1&apiKey=sk-test-claude-key&model=claude-sonnet-4&icon=claude";
    let request = parse_deeplink_url(url).expect("parse deeplink url");

    let db = Arc::new(Database::memory().expect("create memory db"));
    let state = AppState::new(db.clone());

    let provider_id = import_provider_from_deeplink(&state, request.clone())
        .expect("import provider from deeplink");

    // Verify DB state
    let providers = db.get_all_providers("claude").expect("get providers");
    let provider = providers
        .get(&provider_id)
        .expect("provider created via deeplink");

    assert_eq!(provider.name, request.name.clone().unwrap());
    assert_eq!(provider.website_url.as_deref(), request.homepage.as_deref());
    assert_eq!(provider.icon.as_deref(), Some("claude"));
    let auth_token = provider
        .settings_config
        .pointer("/env/ANTHROPIC_AUTH_TOKEN")
        .and_then(|v| v.as_str());
    let base_url = provider
        .settings_config
        .pointer("/env/ANTHROPIC_BASE_URL")
        .and_then(|v| v.as_str());
    assert_eq!(auth_token, request.api_key.as_deref());
    assert_eq!(base_url, request.endpoint.as_deref());
}

#[test]
fn site_logos_persist_independently_of_shared_api_endpoint_and_usage_configuration() {
    let _guard = test_mutex().lock().unwrap();
    reset_test_fs();
    let _home = ensure_test_home();
    let db = Arc::new(Database::memory().unwrap());
    let state = AppState::new(db.clone());
    let script = BASE64_STANDARD.encode("({ request: { url: baseUrl + '/usage' } })");
    let fixtures = [
        (
            "Main",
            "https://main.example",
            "https://main.example/Logo.PNG?Token=AbC",
        ),
        (
            "Branch A",
            "https://branch-a.example",
            "https://cdn.example/A.PNG?Sig=CaseA%2F1",
        ),
        (
            "Branch B",
            "https://branch-b.example",
            "https://cdn.example/a.PNG?Sig=CaseB%2F1",
        ),
        (
            "Custom",
            "https://customer-domain.example",
            "https://customer-domain.example/Uploads/Logo.webp?v=Q",
        ),
    ];
    let mut ids = Vec::new();
    for (name, homepage, logo) in fixtures {
        let url = provider_url(
            "claude",
            name,
            &[
                ("homepage", homepage),
                ("endpoint", "https://shared-api.example/v1"),
                ("apiKey", "sk-fixture"),
                ("model", "claude-sonnet-4"),
                ("icon", " NewAPI "),
                ("iconUrl", logo),
                ("enabled", "false"),
                ("usageScript", &script),
                ("usageEnabled", "false"),
                ("usageBaseUrl", homepage),
            ],
        );
        ids.push(import_url(&state, &url));
    }
    for (id, (_, homepage, logo)) in ids.iter().zip(fixtures) {
        let stored = db.get_provider_by_id(id, "claude").unwrap().unwrap();
        assert_eq!(stored.icon.as_deref(), Some("newapi"));
        assert_eq!(stored.website_url.as_deref(), Some(homepage));
        assert_eq!(
            stored.settings_config["env"]["ANTHROPIC_BASE_URL"],
            "https://shared-api.example/v1"
        );
        assert_eq!(
            stored.settings_config["env"]["ANTHROPIC_AUTH_TOKEN"],
            "sk-fixture"
        );
        assert_eq!(
            stored.settings_config["env"]["ANTHROPIC_MODEL"],
            "claude-sonnet-4"
        );
        let meta = stored.meta.as_ref().unwrap();
        assert_eq!(meta.icon_url.as_deref(), Some(logo));
        let usage = meta.usage_script.as_ref().unwrap();
        assert!(!usage.enabled);
        assert_eq!(usage.base_url.as_deref(), Some(homepage));
        assert_eq!(usage.code, "({ request: { url: baseUrl + '/usage' } })");
        let exported = serde_json::to_value(&stored).unwrap();
        assert_eq!(exported["meta"]["iconUrl"], logo);
        let restored: Provider = serde_json::from_value(exported).unwrap();
        db.save_provider("claude", &restored).unwrap();
        assert_eq!(
            db.get_provider_by_id(id, "claude")
                .unwrap()
                .unwrap()
                .meta
                .unwrap()
                .icon_url
                .as_deref(),
            Some(logo)
        );
    }
    // Metadata edits remain scoped to one supplier, even with the same API URL.
    let mut first = db.get_provider_by_id(&ids[0], "claude").unwrap().unwrap();
    first.meta.as_mut().unwrap().icon_url = None;
    db.save_provider("claude", &first).unwrap();
    assert_eq!(
        db.get_provider_by_id(&ids[1], "claude")
            .unwrap()
            .unwrap()
            .meta
            .unwrap()
            .icon_url
            .as_deref(),
        Some(fixtures[1].2)
    );
}

#[test]
fn deeplink_import_codex_provider_builds_auth_and_config() {
    let _guard = test_mutex().lock().expect("acquire test mutex");
    reset_test_fs();
    let home = ensure_test_home();

    let url = "ccswitch://v1/import?resource=provider&app=codex&name=DeepLink%20Codex&homepage=https%3A%2F%2Fopenai.example&endpoint=https%3A%2F%2Fapi.openai.example%2Fv1&apiKey=sk-test-codex-key&model=gpt-4o&icon=openai";
    let request = parse_deeplink_url(url).expect("parse deeplink url");

    let db = Arc::new(Database::memory().expect("create memory db"));
    let state = AppState::new(db.clone());

    let provider_id = import_provider_from_deeplink(&state, request.clone())
        .expect("import provider from deeplink");

    let providers = db.get_all_providers("codex").expect("get providers");
    let provider = providers
        .get(&provider_id)
        .expect("provider created via deeplink");

    assert_eq!(provider.name, request.name.clone().unwrap());
    assert_eq!(provider.website_url.as_deref(), request.homepage.as_deref());
    assert_eq!(provider.icon.as_deref(), Some("openai"));
    let auth_value = provider
        .settings_config
        .pointer("/auth/OPENAI_API_KEY")
        .and_then(|v| v.as_str());
    let config_text = provider
        .settings_config
        .get("config")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    assert_eq!(auth_value, request.api_key.as_deref());
    assert!(
        config_text.contains(request.endpoint.as_deref().unwrap()),
        "config.toml content should contain endpoint"
    );
    assert!(
        config_text.contains("model = \"gpt-4o\""),
        "config.toml content should contain model setting"
    );
    let config: toml::Value = toml::from_str(config_text).expect("parse stored Codex config");
    assert_eq!(
        config["model_providers"]["custom"]["requires_openai_auth"].as_bool(),
        Some(false),
        "API-key imports must not require a manual authentication edit"
    );
    let live: toml::Value = toml::from_str(
        &fs::read_to_string(home.join(".codex/config.toml")).expect("read first provider config"),
    )
    .expect("parse first provider config");
    assert_eq!(
        live["model_providers"]["custom"]["experimental_bearer_token"].as_str(),
        request.api_key.as_deref()
    );
    assert_eq!(
        live["model_providers"]["custom"]["requires_openai_auth"].as_bool(),
        Some(false)
    );
    assert!(!home.join(".codex/auth.json").exists());
}

#[test]
fn deeplink_codex_explicit_models_reach_the_live_catalog() {
    let _guard = test_mutex().lock().expect("acquire test mutex");
    reset_test_fs();
    let home = ensure_test_home();
    let db = Arc::new(Database::memory().expect("create memory db"));
    let state = AppState::new(db.clone());

    let url = provider_url(
        "codex",
        "NewAPI relay",
        &[
            ("endpoint", "https://api.example.com/v1"),
            ("apiKey", "sk-fixture"),
            ("model", "gpt-6-sol"),
            ("models", "gpt-6-sol,gpt-6-luna"),
        ],
    );
    let provider_id = import_url(&state, &url);
    let provider = db
        .get_provider_by_id(&provider_id, "codex")
        .unwrap()
        .expect("saved Codex provider");
    assert_eq!(
        provider.settings_config["modelCatalog"]["models"]
            .as_array()
            .unwrap()
            .len(),
        2
    );

    let config: toml::Value = toml::from_str(
        &fs::read_to_string(home.join(".codex/config.toml")).expect("read live Codex config"),
    )
    .expect("parse live Codex config");
    assert_eq!(config["model"].as_str(), Some("gpt-6-sol"));
    assert_eq!(
        config["model_catalog_json"].as_str(),
        Some("cc-switch-model-catalog.json")
    );

    let catalog: Value = serde_json::from_slice(
        &fs::read(home.join(".codex/cc-switch-model-catalog.json"))
            .expect("read generated model catalog"),
    )
    .expect("parse generated model catalog");
    let models = catalog["models"].as_array().expect("model catalog entries");
    assert_eq!(models.len(), 2);
    assert_eq!(models[0]["slug"], "gpt-6-sol");
    assert_eq!(models[1]["slug"], "gpt-6-luna");
}

#[test]
fn deeplink_codex_import_and_switch_use_the_key_without_manual_edits() {
    let _guard = test_mutex().lock().expect("acquire test mutex");

    for preserve_login in [false, true] {
        for enabled in [false, true] {
            for inline_config in [false, true] {
                reset_test_fs();
                let home = ensure_test_home();
                update_settings(AppSettings {
                    preserve_codex_official_auth_on_switch: preserve_login,
                    ..Default::default()
                })
                .expect("set isolated login preservation preference");
                let db = Arc::new(Database::memory().expect("create memory db"));
                let state = AppState::new(db.clone());
                let mut official = Provider::with_id(
                    "official".into(),
                    "OpenAI Official".into(),
                    json!({
                        "auth": {
                            "auth_mode": "chatgpt",
                            "tokens": {"access_token": "test-official-token"}
                        },
                        "config": "model = \"gpt-5-codex\"\n"
                    }),
                    None,
                );
                official.category = Some("official".into());
                ProviderService::add(&state, AppType::Codex, official, true)
                    .expect("seed official provider");
                let config_path = home.join(".codex/config.toml");
                let auth_path = home.join(".codex/auth.json");
                let original_config = fs::read(&config_path).expect("read official config");
                let original_auth = fs::read(&auth_path).expect("read official auth");

                // Older links can carry their key in an inline Codex config.
                let encoded = BASE64_STANDARD.encode(
                    json!({
                        "auth": {},
                        "config": concat!(
                            "model_provider = \"relay\"\nmodel = \"gpt-5-codex\"\n",
                            "[model_providers.relay]\nname = \"Relay\"\n",
                            "base_url = \"https://relay.example/v1\"\n",
                            "requires_openai_auth = true\n",
                            "experimental_bearer_token = \"sk-deeplink-test\"\n"
                        )
                    })
                    .to_string(),
                );
                let logo = "https://tenant.example/Logo.PNG?Token=AbC%2FDeF";
                let mut params = vec![
                    ("enabled", if enabled { "true" } else { "false" }),
                    ("iconUrl", logo),
                ];
                if inline_config {
                    params.extend([("configFormat", "json"), ("config", encoded.as_str())]);
                } else {
                    params.extend([
                        ("endpoint", "https://relay.example/v1"),
                        ("apiKey", "sk-deeplink-test"),
                        ("model", "gpt-5-codex"),
                    ]);
                }
                let id = import_url(&state, &provider_url("codex", "Relay", &params));
                let stored = db
                    .get_provider_by_id(&id, "codex")
                    .expect("query imported provider")
                    .expect("imported provider exists");
                assert_eq!(
                    stored.meta.as_ref().unwrap().icon_url.as_deref(),
                    Some(logo)
                );
                let config: toml::Value =
                    toml::from_str(stored.settings_config["config"].as_str().unwrap())
                        .expect("parse imported config");
                assert_eq!(
                    config["model_providers"]["custom"]["requires_openai_auth"].as_bool(),
                    Some(false)
                );
                assert_eq!(
                    stored.settings_config["auth"]["OPENAI_API_KEY"],
                    "sk-deeplink-test"
                );
                if !enabled {
                    assert_eq!(
                        db.get_current_provider("codex").unwrap().as_deref(),
                        Some("official")
                    );
                    assert_eq!(fs::read(&config_path).unwrap(), original_config);
                    assert_eq!(fs::read(&auth_path).unwrap(), original_auth);
                    ProviderService::switch(&state, AppType::Codex, &id)
                        .expect("enable saved import without editing");
                }

                // Check both initial activation and switching back after a live backfill.
                for activation in 0..2 {
                    if activation == 1 {
                        ProviderService::switch(&state, AppType::Codex, "official")
                            .expect("switch back to official login");
                        assert_eq!(fs::read(&auth_path).unwrap(), original_auth);
                        let backfilled = db
                            .get_provider_by_id(&id, "codex")
                            .expect("query backfilled provider")
                            .expect("backfilled provider exists");
                        assert_eq!(
                            backfilled.meta.as_ref().unwrap().icon_url.as_deref(),
                            Some(logo)
                        );
                        assert_eq!(
                            backfilled.settings_config["auth"]["OPENAI_API_KEY"],
                            "sk-deeplink-test"
                        );
                        assert!(!backfilled.settings_config["config"]
                            .as_str()
                            .unwrap()
                            .contains("experimental_bearer_token"));
                        ProviderService::switch(&state, AppType::Codex, &id)
                            .expect("switch to imported provider again");
                    }
                    assert_eq!(
                        db.get_current_provider("codex").unwrap().as_deref(),
                        Some(id.as_str())
                    );
                    let live: toml::Value =
                        toml::from_str(&fs::read_to_string(&config_path).unwrap())
                            .expect("parse active imported config");
                    let custom = &live["model_providers"]["custom"];
                    assert_eq!(
                        custom["base_url"].as_str(),
                        Some("https://relay.example/v1")
                    );
                    assert_eq!(custom["wire_api"].as_str(), Some("responses"));
                    assert_eq!(
                        custom["experimental_bearer_token"].as_str(),
                        Some("sk-deeplink-test")
                    );
                    assert_eq!(
                        custom["requires_openai_auth"].as_bool(),
                        Some(preserve_login)
                    );
                    if preserve_login {
                        assert_eq!(fs::read(&auth_path).unwrap(), original_auth);
                    } else {
                        assert!(!auth_path.exists());
                    }
                }
            }
        }
    }
}

#[test]
fn deeplink_desktop_app_aliases_normalize_to_canonical_id() {
    for app in ["claude-desktop", "claude_desktop", "claudedesktop"] {
        let url = provider_url(
            app,
            "Desktop Alias",
            &[
                ("endpoint", "https://desktop-alias.example.com/v1"),
                ("apiKey", "sk-desktop-alias"),
            ],
        );
        let request = parse_deeplink_url(&url).expect("parse Desktop alias");
        assert_eq!(
            request.app.as_deref(),
            Some(DESKTOP_APP),
            "{app} should normalize to the canonical Desktop app id"
        );
    }
}

#[test]
fn deeplink_desktop_inline_json_and_toml_preserve_custom_env_with_url_precedence() {
    let _guard = test_mutex().lock().expect("acquire test mutex");
    reset_test_fs();
    let home = ensure_test_home();
    clean_desktop_fixtures(home);

    let fixtures = [
        (
            "json",
            r#"{"env":{"ANTHROPIC_AUTH_TOKEN":"sk-config","ANTHROPIC_BASE_URL":"https://config-json.example.com/v1","ANTHROPIC_MODEL":"config-json-model","CUSTOM_HEADER":"json-custom","CUSTOM_NUMBER":17}}"#,
        ),
        (
            "toml",
            r#"[env]
ANTHROPIC_AUTH_TOKEN = "sk-config"
ANTHROPIC_BASE_URL = "https://config-toml.example.com/v1"
ANTHROPIC_MODEL = "config-toml-model"
CUSTOM_HEADER = "toml-custom"
CUSTOM_NUMBER = 23
"#,
        ),
    ];

    for (format, config) in fixtures {
        let db = Arc::new(Database::memory().expect("create memory db"));
        let state = AppState::new(db.clone());
        let encoded = BASE64_STANDARD.encode(config.as_bytes());
        let name = format!("Desktop {format}");
        let url = provider_url(
            "claude_desktop",
            &name,
            &[
                ("endpoint", "https://url-override.example.com/v1"),
                ("apiKey", "sk-url-override"),
                ("model", "claude-sonnet-url-override"),
                ("config", encoded.as_str()),
                ("configFormat", format),
            ],
        );

        let provider_id = import_url(&state, &url);
        let provider = db
            .get_all_providers(DESKTOP_APP)
            .expect("get Desktop providers")
            .get(&provider_id)
            .cloned()
            .expect("Desktop provider persisted under canonical app id");
        let env = provider
            .settings_config
            .get("env")
            .and_then(Value::as_object)
            .expect("Desktop env object");

        assert_eq!(env["ANTHROPIC_AUTH_TOKEN"], json!("sk-url-override"));
        assert_eq!(
            env["ANTHROPIC_BASE_URL"],
            json!("https://url-override.example.com/v1")
        );
        assert_eq!(env["ANTHROPIC_MODEL"], json!("claude-sonnet-url-override"));
        assert_eq!(
            env["CUSTOM_HEADER"],
            json!(format!("{format}-custom")),
            "custom string env should survive {format} import"
        );
        assert_eq!(
            env["CUSTOM_NUMBER"],
            json!(if format == "json" { 17 } else { 23 }),
            "custom typed env should survive {format} import"
        );

        let inline_id = import_url(
            &state,
            &provider_url(
                DESKTOP_APP,
                &format!("Desktop Inline Only {format}"),
                &[("config", &encoded), ("configFormat", format)],
            ),
        );
        let inline = db
            .get_provider_by_id(&inline_id, DESKTOP_APP)
            .unwrap()
            .unwrap();
        assert_eq!(
            inline.settings_config["env"]["ANTHROPIC_AUTH_TOKEN"],
            "sk-config"
        );
        assert_eq!(
            inline.settings_config["env"]["ANTHROPIC_BASE_URL"],
            format!("https://config-{format}.example.com/v1")
        );
        assert_eq!(
            inline.settings_config["env"]["ANTHROPIC_MODEL"],
            format!("config-{format}-model")
        );
    }
}

#[test]
fn deeplink_desktop_safe_claude_models_build_direct_identity_routes() {
    let _guard = test_mutex().lock().expect("acquire test mutex");
    reset_test_fs();
    let home = ensure_test_home();
    clean_desktop_fixtures(home);

    let db = Arc::new(Database::memory().expect("create memory db"));
    let state = AppState::new(db.clone());
    let url = provider_url(
        DESKTOP_APP,
        "Desktop Direct",
        &[
            ("endpoint", "https://desktop-direct.example.com/v1"),
            ("apiKey", "sk-desktop-direct"),
            ("sonnetModel", "claude-sonnet-4-6[1M]"),
            ("opusModel", "claude-opus-4-6"),
            ("haikuModel", "anthropic/claude-haiku-4-5"),
        ],
    );

    let provider_id = import_url(&state, &url);
    let provider = db
        .get_all_providers(DESKTOP_APP)
        .expect("get Desktop providers")
        .get(&provider_id)
        .cloned()
        .expect("direct Desktop provider");
    let meta = provider_meta_json(&provider);
    assert_eq!(meta["claudeDesktopMode"], json!("direct"));

    let routes = meta["claudeDesktopModelRoutes"]
        .as_object()
        .expect("direct routes object");
    assert_eq!(routes.len(), 3);
    for model in [
        "claude-sonnet-4-6",
        "claude-opus-4-6",
        "anthropic/claude-haiku-4-5",
    ] {
        assert_eq!(
            routes.get(model).and_then(|route| route["model"].as_str()),
            Some(model),
            "direct route key and upstream model must be identical"
        );
    }
    assert_eq!(
        routes["claude-sonnet-4-6"]["supports1m"],
        json!(true),
        "[1M] must be stripped from the model id and translated to supports1m"
    );
    assert!(
        !meta.to_string().to_ascii_lowercase().contains("[1m]"),
        "Desktop metadata must not persist the suffix marker"
    );
}

#[test]
fn deeplink_desktop_non_claude_tiers_keep_each_official_proxy_role() {
    let _guard = test_mutex().lock().expect("acquire test mutex");
    reset_test_fs();
    let home = ensure_test_home();
    clean_desktop_fixtures(home);

    let db = Arc::new(Database::memory().expect("create memory db"));
    let state = AppState::new(db.clone());
    let url = provider_url(
        DESKTOP_APP,
        "Desktop Proxy Shared",
        &[
            ("endpoint", "https://desktop-proxy.example.com/v1"),
            ("apiKey", "sk-desktop-proxy"),
            ("model", "must-not-add-a-fourth-route"),
            ("sonnetModel", "shared-upstream-model[1m]"),
            ("opusModel", "shared-upstream-model"),
            ("haikuModel", "shared-upstream-model"),
        ],
    );

    let provider_id = import_url(&state, &url);
    let provider = db
        .get_all_providers(DESKTOP_APP)
        .expect("get Desktop providers")
        .get(&provider_id)
        .cloned()
        .expect("proxy Desktop provider");
    let meta = provider_meta_json(&provider);
    assert_eq!(meta["claudeDesktopMode"], json!("proxy"));
    let routes = meta["claudeDesktopModelRoutes"]
        .as_object()
        .expect("proxy routes object");

    let defaults = get_claude_desktop_default_routes();
    let requested_roles = [
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    ];
    let expected_route_ids = defaults
        .iter()
        .filter(|route| requested_roles.contains(&route.env_key))
        .map(|route| route.route_id)
        .collect::<Vec<_>>();
    assert_eq!(expected_route_ids.len(), 3, "official role definitions");
    assert_eq!(
        routes.len(),
        expected_route_ids.len(),
        "the generic model fallback must not add a route when tier fields exist"
    );
    for route_id in expected_route_ids {
        let route = routes
            .get(route_id)
            .unwrap_or_else(|| panic!("missing official Desktop route {route_id}"));
        assert_eq!(route["model"], json!("shared-upstream-model"));
    }

    let sonnet_route = defaults
        .iter()
        .find(|route| route.env_key == "ANTHROPIC_DEFAULT_SONNET_MODEL")
        .expect("official Sonnet route");
    assert_eq!(routes[sonnet_route.route_id]["supports1m"], json!(true));
    assert!(
        !meta.to_string().to_ascii_lowercase().contains("[1m]"),
        "proxy route model must not persist the suffix marker"
    );
}

#[test]
fn deeplink_desktop_single_non_claude_model_falls_back_to_official_sonnet_only() {
    let _guard = test_mutex().lock().expect("acquire test mutex");
    reset_test_fs();
    let home = ensure_test_home();
    clean_desktop_fixtures(home);

    let db = Arc::new(Database::memory().expect("create memory db"));
    let state = AppState::new(db.clone());
    let url = provider_url(
        DESKTOP_APP,
        "Desktop Single Model",
        &[
            ("endpoint", "https://desktop-single.example.com/v1"),
            ("apiKey", "sk-desktop-single"),
            ("model", "single-upstream-model"),
        ],
    );

    let provider_id = import_url(&state, &url);
    let provider = db
        .get_all_providers(DESKTOP_APP)
        .expect("get Desktop providers")
        .get(&provider_id)
        .cloned()
        .expect("single-model Desktop provider");
    let meta = provider_meta_json(&provider);
    assert_eq!(meta["claudeDesktopMode"], json!("proxy"));
    let routes = meta["claudeDesktopModelRoutes"]
        .as_object()
        .expect("single fallback route object");
    let sonnet_route = get_claude_desktop_default_routes()
        .into_iter()
        .find(|route| route.env_key == "ANTHROPIC_DEFAULT_SONNET_MODEL")
        .expect("official Sonnet route");
    assert_eq!(routes.len(), 1);
    assert_eq!(
        routes[sonnet_route.route_id]["model"],
        json!("single-upstream-model")
    );
}

#[test]
fn deeplink_desktop_disabled_import_preserves_current_settings_and_live_files() {
    let _guard = test_mutex().lock().expect("acquire test mutex");
    reset_test_fs();
    let home = ensure_test_home();
    clean_desktop_fixtures(home);

    let db = Arc::new(Database::memory().expect("create memory db"));
    let state = AppState::new(db.clone());
    let active_url = provider_url(
        DESKTOP_APP,
        "Desktop Active",
        &[
            ("endpoint", "https://desktop-active.example.com/v1"),
            ("apiKey", "sk-desktop-active"),
            ("model", "claude-sonnet-4-6"),
        ],
    );
    let active_id = import_url(&state, &active_url);
    db.set_current_provider(DESKTOP_APP, &active_id)
        .expect("set existing DB current");
    update_settings(AppSettings {
        current_provider_claude_desktop: Some(active_id.clone()),
        ..AppSettings::default()
    })
    .expect("set existing device current");
    let (normal, threep) = desktop_config_dirs(home);
    let config_library = threep.join("configLibrary");
    fs::create_dir_all(&normal).expect("create normal Desktop fixture directory");
    fs::create_dir_all(&config_library).expect("create 3P Desktop fixture directory");
    fs::write(
        normal.join("claude_desktop_config.json"),
        br#"{"deploymentMode":"fixture-normal"}"#,
    )
    .expect("write normal Desktop fixture");
    fs::write(
        threep.join("claude_desktop_config.json"),
        br#"{"deploymentMode":"fixture-3p"}"#,
    )
    .expect("write 3P Desktop fixture");
    fs::write(config_library.join("existing.json"), b"profile-fixture")
        .expect("write Desktop profile fixture");
    fs::write(config_library.join("_meta.json"), b"meta-fixture")
        .expect("write Desktop meta fixture");
    let live_before = snapshot_desktop_files(home);
    let settings_before = fs::read(desktop_settings_path(home)).expect("read device settings");

    for enabled in [None, Some("false")] {
        let mut extra = vec![
            ("endpoint", "https://desktop-saved.example.com/v1"),
            ("apiKey", "sk-desktop-saved"),
            ("model", "claude-haiku-4-5"),
        ];
        if let Some(value) = enabled {
            extra.push(("enabled", value));
        }
        let name = if enabled.is_some() {
            "Desktop Explicit Disabled"
        } else {
            "Desktop Default Disabled"
        };
        import_url(&state, &provider_url(DESKTOP_APP, name, &extra));

        assert_eq!(
            db.get_current_provider(DESKTOP_APP)
                .expect("get DB current Desktop provider")
                .as_deref(),
            Some(active_id.as_str())
        );
        assert_eq!(
            fs::read(desktop_settings_path(home)).expect("read unchanged device settings"),
            settings_before
        );
        assert_eq!(snapshot_desktop_files(home), live_before);
    }
    assert_eq!(
        db.get_all_providers(DESKTOP_APP)
            .expect("get all persisted Desktop providers")
            .len(),
        3,
        "the active provider plus both disabled imports should remain in DB"
    );
}

#[test]
fn deeplink_desktop_disabled_import_preserves_official_or_empty_current() {
    let _guard = test_mutex().lock().expect("acquire test mutex");
    reset_test_fs();
    let home = ensure_test_home();
    clean_desktop_fixtures(home);

    for official_current in [false, true] {
        clean_desktop_fixtures(home);
        let db = Arc::new(Database::memory().expect("create memory db"));
        db.init_default_official_providers()
            .expect("seed official providers");
        let state = AppState::new(db.clone());
        let expected_current = if official_current {
            let official_id = db
                .get_all_providers(DESKTOP_APP)
                .expect("get seeded Desktop providers")
                .into_iter()
                .find_map(|(id, provider)| {
                    (provider.category.as_deref() == Some("official")).then_some(id)
                })
                .expect("Desktop official provider");
            db.set_current_provider(DESKTOP_APP, &official_id)
                .expect("set official DB current");
            update_settings(AppSettings {
                current_provider_claude_desktop: Some(official_id.clone()),
                ..AppSettings::default()
            })
            .expect("set official device current");
            Some(official_id)
        } else {
            update_settings(AppSettings::default()).expect("clear device current");
            None
        };
        let live_before = snapshot_desktop_files(home);
        let settings_before = fs::read(desktop_settings_path(home)).expect("read device settings");
        let url = provider_url(
            DESKTOP_APP,
            if official_current {
                "Desktop Saved From Official"
            } else {
                "Desktop Saved Without Current"
            },
            &[
                ("endpoint", "https://desktop-db-only.example.com/v1"),
                ("apiKey", "sk-desktop-db-only"),
                ("model", "claude-sonnet-4-6"),
                ("enabled", "false"),
            ],
        );

        let imported_id = import_url(&state, &url);
        assert!(
            db.get_all_providers(DESKTOP_APP)
                .expect("get Desktop providers")
                .contains_key(&imported_id),
            "disabled Desktop provider should still be saved"
        );
        assert_eq!(
            db.get_current_provider(DESKTOP_APP)
                .expect("get preserved DB current"),
            expected_current
        );
        assert_eq!(
            fs::read(desktop_settings_path(home)).expect("read preserved device settings"),
            settings_before
        );
        assert_eq!(snapshot_desktop_files(home), live_before);
    }
}

#[cfg(any(target_os = "macos", windows))]
#[test]
fn deeplink_desktop_enabled_import_switches_and_writes_isolated_profile() {
    let _guard = test_mutex().lock().expect("acquire test mutex");
    reset_test_fs();
    let home = ensure_test_home();
    clean_desktop_fixtures(home);

    let db = Arc::new(Database::memory().expect("create memory db"));
    let state = AppState::new(db.clone());
    let url = provider_url(
        DESKTOP_APP,
        "Desktop Enabled",
        &[
            ("endpoint", "https://desktop-enabled.example.com/v1"),
            ("apiKey", "sk-desktop-enabled"),
            ("model", "claude-sonnet-4-6"),
            ("enabled", "true"),
        ],
    );

    let provider_id = import_url(&state, &url);
    assert_eq!(
        db.get_current_provider(DESKTOP_APP)
            .expect("get current Desktop provider")
            .as_deref(),
        Some(provider_id.as_str())
    );
    let device_settings: Value = serde_json::from_slice(
        &fs::read(desktop_settings_path(home)).expect("read device settings after switch"),
    )
    .expect("parse device settings after switch");
    assert_eq!(
        device_settings["currentProviderClaudeDesktop"],
        json!(provider_id)
    );

    let profile = desktop_profile(home);
    assert_eq!(
        profile["inferenceGatewayBaseUrl"],
        json!("https://desktop-enabled.example.com/v1")
    );
    assert_eq!(
        profile["inferenceGatewayApiKey"],
        json!("sk-desktop-enabled")
    );
    assert_eq!(profile["inferenceProvider"], json!("gateway"));
    assert_eq!(profile["inferenceModels"][0]["name"], "claude-sonnet-4-6");

    // The same explicit switch path must also write an imported proxy profile.
    let proxy_id = import_url(
        &state,
        &provider_url(
            DESKTOP_APP,
            "Desktop Enabled Proxy",
            &[
                ("endpoint", "https://desktop-proxy.example.com/v1"),
                ("apiKey", "sk-desktop-proxy"),
                ("sonnetModel", "upstream-sonnet"),
                ("haikuModel", "upstream-haiku"),
                ("opusModel", "upstream-opus"),
                ("enabled", "true"),
            ],
        ),
    );
    assert_eq!(
        db.get_current_provider(DESKTOP_APP).unwrap(),
        Some(proxy_id)
    );
    let profile = desktop_profile(home);
    assert!(profile["inferenceGatewayBaseUrl"]
        .as_str()
        .unwrap()
        .starts_with("http://127.0.0.1:"));
    assert!(profile["inferenceGatewayBaseUrl"]
        .as_str()
        .unwrap()
        .ends_with("/claude-desktop"));
    assert_eq!(profile["inferenceModels"].as_array().unwrap().len(), 3);
}

#[test]
fn deeplink_desktop_invalid_credentials_or_urls_have_no_side_effects() {
    let _guard = test_mutex().lock().expect("acquire test mutex");
    reset_test_fs();
    let home = ensure_test_home();
    clean_desktop_fixtures(home);

    let db = Arc::new(Database::memory().expect("create memory db"));
    let state = AppState::new(db.clone());
    let live_before = snapshot_desktop_files(home);
    let settings_before = fs::read(desktop_settings_path(home)).expect("read device settings");
    let invalid_cases = [
        provider_url(
            DESKTOP_APP,
            "Desktop Empty Key",
            &[
                ("endpoint", "https://invalid-key.example.com/v1"),
                ("apiKey", ""),
                ("enabled", "true"),
            ],
        ),
        provider_url(
            DESKTOP_APP,
            "Desktop Empty Endpoint",
            &[
                ("endpoint", ""),
                ("apiKey", "sk-empty-endpoint"),
                ("enabled", "true"),
            ],
        ),
        provider_url(
            DESKTOP_APP,
            "Desktop Invalid Endpoint",
            &[
                ("endpoint", "not-a-valid-url"),
                ("apiKey", "sk-invalid-endpoint"),
                ("enabled", "true"),
            ],
        ),
        provider_url(
            DESKTOP_APP,
            "Desktop Invalid Inline Endpoint",
            &[("config", &BASE64_STANDARD.encode(r#"{"env":{"ANTHROPIC_AUTH_TOKEN":"test-key","ANTHROPIC_BASE_URL":"file:///tmp/desktop-invalid"}}"#))],
        ),
    ];

    for url in invalid_cases {
        let result = parse_deeplink_url(&url)
            .and_then(|request| import_provider_from_deeplink(&state, request));
        assert!(result.is_err(), "invalid Desktop deeplink must be rejected");
        assert!(
            db.get_all_providers(DESKTOP_APP)
                .expect("get Desktop providers after rejected import")
                .is_empty(),
            "rejected import must not create a DB row"
        );
        assert_eq!(
            fs::read(desktop_settings_path(home)).expect("read unchanged device settings"),
            settings_before
        );
        assert_eq!(snapshot_desktop_files(home), live_before);
    }
}
