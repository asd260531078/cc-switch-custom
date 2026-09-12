use super::TestHomeGuard;
use crate::deeplink::{import_provider_from_deeplink, parse_deeplink_url, DeepLinkImportRequest};
use crate::pi_config::{self, test_support::TestAgentDir};
use crate::{AppState, AppType, Database, Provider, ProviderService};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use serial_test::serial;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use url::Url;

fn request() -> DeepLinkImportRequest {
    DeepLinkImportRequest {
        version: "v1".into(),
        resource: "provider".into(),
        app: Some("pi".into()),
        name: Some("Pi 测试".into()),
        endpoint: Some("https://api.example.com/v1".into()),
        api_key: Some("sk-pi-test".into()),
        model: Some("test-model".into()),
        ..Default::default()
    }
}

fn url(request: &DeepLinkImportRequest) -> String {
    let mut url = Url::parse("ccswitch://v1/import").unwrap();
    for (key, value) in serde_json::to_value(request).unwrap().as_object().unwrap() {
        match value {
            serde_json::Value::String(value) => {
                url.query_pairs_mut().append_pair(key, value);
            }
            serde_json::Value::Bool(value) => {
                url.query_pairs_mut().append_pair(key, &value.to_string());
            }
            serde_json::Value::Number(value) => {
                url.query_pairs_mut().append_pair(key, &value.to_string());
            }
            _ => {}
        }
    }
    url.into()
}

#[test]
fn pi_provider_url_is_accepted() {
    let parsed = parse_deeplink_url(&url(&request())).expect("parse Pi provider URL");
    assert_eq!(parsed.app.as_deref(), Some("pi"));
}

#[test]
#[serial]
fn pi_direct_import_saves_native_provider() {
    let _home = TestHomeGuard::new();
    let _agent = TestAgentDir::new();
    let state = AppState::new(Arc::new(Database::memory().unwrap()));
    let mut request = request();
    request.enabled = Some(true);
    let id = import_provider_from_deeplink(&state, request).expect("import Pi provider");
    assert!(pi_config::pi_provider_exists(&id).unwrap());
}

fn state() -> AppState {
    AppState::new(Arc::new(Database::memory().unwrap()))
}

fn models() -> Value {
    serde_json::from_slice(&fs::read(pi_config::get_pi_models_path().unwrap()).unwrap()).unwrap()
}

fn seed_native(state: &AppState) -> (Value, Vec<(PathBuf, Vec<u8>)>) {
    let agent = pi_config::get_pi_agent_dir().unwrap();
    fs::create_dir_all(&agent).unwrap();
    let existing = json!({
        "name": "Existing native provider",
        "apiKey": "fixture-existing-key",
        "api": "openai-completions",
        "baseUrl": "https://existing.example/v1",
        "models": [{"id": "existing-model", "unknown": {"keep": true}}],
        "unknown": [1, 2, 3]
    });
    let native = json!({
        "unknownTopLevel": {"keep": true},
        "providers": {"anthropic": existing}
    });
    fs::write(
        agent.join("models.json"),
        serde_json::to_vec(&native).unwrap(),
    )
    .unwrap();
    state
        .db
        .save_provider(
            "pi",
            &Provider::with_id(
                "anthropic".into(),
                "Existing saved provider".into(),
                existing,
                None,
            ),
        )
        .unwrap();
    state.db.set_current_provider("pi", "anthropic").unwrap();
    let untouched = vec![
        (
            agent.join("settings.json"),
            br#"{"defaultProvider":"anthropic","defaultModel":"existing-model","unknown":true}"#
                .to_vec(),
        ),
        // Deliberately invalid credential fixture: an import must not parse it.
        (
            agent.join("auth.json"),
            b"not real credentials or valid JSON".to_vec(),
        ),
        (
            crate::config::get_home_dir()
                .join(".codex")
                .join("config.toml"),
            b"model = 'untouched'\n".to_vec(),
        ),
    ];
    for (path, bytes) in &untouched {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }
    state
        .db
        .save_provider(
            "codex",
            &Provider::with_id(
                "other-app".into(),
                "Other app".into(),
                json!({"fixture":true}),
                None,
            ),
        )
        .unwrap();
    state.db.set_current_provider("codex", "other-app").unwrap();
    (native, untouched)
}

#[test]
#[serial]
fn pi_url_to_import_preserves_encoding_membership_defaults_and_other_apps() {
    let _home = TestHomeGuard::new();
    let _agent = TestAgentDir::new();
    let state = state();
    let (original, untouched) = seed_native(&state);
    let mut request = request();
    request.name = Some("Pi 中文 + & / % \"测试\"".into());
    request.endpoint = Some("https://api.example.com/Case%2FPath/v1/".into());
    request.api_key = Some("sk-test+&=%25#?/中文".into());
    request.model = Some(" vendor/model + & %25 #中文 ".into());
    request.icon = Some("pi".into());
    request.icon_url = Some("https://logo.example.com/Logo%2FOne.png?Case=A%2BB".into());
    request.notes = Some("Imported fixture".into());
    let original_saved = serde_json::to_value(state.db.get_all_providers("pi").unwrap()).unwrap();
    let other_app = serde_json::to_value(state.db.get_all_providers("codex").unwrap()).unwrap();
    let mut ids = Vec::new();

    for enabled in [None, Some(false), Some(true), Some(true)] {
        request.enabled = enabled;
        let before = fs::read(pi_config::get_pi_models_path().unwrap()).unwrap();
        let parsed = parse_deeplink_url(&url(&request)).unwrap();
        assert_eq!(parsed.api_key, request.api_key);
        assert_eq!(parsed.model, request.model);
        assert_eq!(parsed.name, request.name);
        assert_eq!(parsed.icon_url, request.icon_url);
        let id = import_provider_from_deeplink(&state, parsed).unwrap();
        assert!(
            !ids.contains(&id),
            "repeated imports need distinct native IDs"
        );
        ids.push(id.clone());
        let provider = state.db.get_provider_by_id(&id, "pi").unwrap().unwrap();
        assert_eq!(provider.name, request.name.clone().unwrap());
        assert_eq!(provider.icon.as_deref(), Some("pi"));
        assert_eq!(
            provider
                .meta
                .as_ref()
                .and_then(|meta| meta.icon_url.as_ref()),
            request.icon_url.as_ref()
        );
        assert_eq!(provider.notes, request.notes);
        assert_eq!(
            provider.settings_config,
            json!({
                "name": request.name,
                "apiKey": request.api_key,
                "baseUrl": "https://api.example.com/Case%2FPath/v1/",
                "api": "openai-completions",
                "models": [{"id": request.model}]
            })
        );
        if enabled == Some(true) {
            assert_eq!(models()["providers"][&id], provider.settings_config);
        } else {
            assert_eq!(
                fs::read(pi_config::get_pi_models_path().unwrap()).unwrap(),
                before
            );
        }
        assert_eq!(
            models()["providers"]["anthropic"],
            original["providers"]["anthropic"]
        );
        assert_eq!(models()["unknownTopLevel"], original["unknownTopLevel"]);
        assert_eq!(
            serde_json::to_value(
                state
                    .db
                    .get_provider_by_id("anthropic", "pi")
                    .unwrap()
                    .unwrap()
            )
            .unwrap(),
            original_saved["anthropic"]
        );
        assert_eq!(
            state.db.get_current_provider("pi").unwrap().as_deref(),
            Some("anthropic")
        );
        assert_eq!(
            serde_json::to_value(state.db.get_all_providers("codex").unwrap()).unwrap(),
            other_app
        );
        assert_eq!(
            state.db.get_current_provider("codex").unwrap().as_deref(),
            Some("other-app")
        );
        for (path, bytes) in &untouched {
            assert_eq!(&fs::read(path).unwrap(), bytes);
        }
    }
    assert_eq!(models()["providers"].as_object().unwrap().len(), 3);
}

#[test]
#[serial]
fn pi_first_save_only_does_not_create_native_config_or_select_a_provider() {
    let _home = TestHomeGuard::new();
    let _agent = TestAgentDir::new();
    let state = state();
    let parsed = parse_deeplink_url(&url(&request())).unwrap();
    import_provider_from_deeplink(&state, parsed).unwrap();
    assert!(!pi_config::get_pi_models_path().unwrap().exists());
    assert!(!pi_config::get_pi_settings_path().unwrap().exists());
    assert!(state.db.get_current_provider("pi").unwrap().is_none());
}

#[test]
#[serial]
fn pi_missing_or_invalid_fields_fail_before_writing() {
    let _home = TestHomeGuard::new();
    let _agent = TestAgentDir::new();
    let state = state();
    let mut invalid = Vec::new();
    for field in ["name", "endpoint", "apiKey", "model"] {
        for value in [Value::Null, json!(""), json!(" \n\t ")] {
            let mut input = serde_json::to_value(request()).unwrap();
            input[field] = value;
            invalid.push(serde_json::from_value::<DeepLinkImportRequest>(input).unwrap());
        }
    }
    for endpoint in [
        "file:///tmp/pi",
        "relative/v1",
        "https://api.example.com/v1/chat/completions",
        "https://api.example.com/v1/responses/",
        "https://api.example.com/v1/messages",
        "https://one.example/v1,https://two.example/v1",
    ] {
        let mut input = request();
        input.endpoint = Some(endpoint.into());
        invalid.push(input);
    }
    for key in [
        "!echo injected",
        "  !echo injected",
        "$ENV_SECRET",
        "sk-${ENV_SECRET}",
        "$$escaped",
        "$!escaped",
    ] {
        let mut input = request();
        input.api_key = Some(key.into());
        invalid.push(input);
    }
    let mut input = request();
    input.homepage = Some("javascript:alert(1)".into());
    invalid.push(input);
    for input in invalid {
        assert!(parse_deeplink_url(&url(&input)).is_err());
        assert!(
            import_provider_from_deeplink(&state, input).is_err(),
            "IPC must validate too"
        );
    }
    assert!(state.db.get_all_providers("pi").unwrap().is_empty());
    assert!(!pi_config::get_pi_models_path().unwrap().exists());
}

#[test]
#[serial]
fn pi_rejects_inline_and_remote_config_without_silently_ignoring_it() {
    let _home = TestHomeGuard::new();
    let _agent = TestAgentDir::new();
    let state = state();
    for remote in [false, true] {
        let mut input = request();
        if remote {
            input.config_url = Some("https://example.com/config.json".into());
        } else {
            input.config = Some(STANDARD.encode(r#"{"api":"anthropic-messages"}"#));
        }
        assert!(parse_deeplink_url(&url(&input)).is_err());
        let error = import_provider_from_deeplink(&state, input)
            .unwrap_err()
            .to_string();
        assert!(error.contains("config/configUrl is not supported"));
    }
    assert!(state.db.get_all_providers("pi").unwrap().is_empty());
    assert!(!pi_config::get_pi_models_path().unwrap().exists());
}

#[test]
#[serial]
fn pi_usage_settings_and_provider_credentials_survive_native_refresh() {
    let _home = TestHomeGuard::new();
    let _agent = TestAgentDir::new();
    let state = state();
    let code = "({ request: { url: '{{baseUrl}}/balance?name=中文' }, extractor: function() { return { remaining: 0 }; } })";
    for separate_usage in [false, true] {
        let mut input = request();
        input.enabled = Some(true);
        input.usage_script = Some(STANDARD.encode(code));
        input.usage_enabled = Some(separate_usage);
        input.usage_api_key = if separate_usage {
            Some("sk-usage-fixture".into())
        } else {
            input.api_key.clone()
        };
        input.usage_base_url = if separate_usage {
            Some("https://usage.example.com/".into())
        } else {
            input.endpoint.clone()
        };
        input.usage_access_token = Some("fixture-access-token".into());
        input.usage_user_id = Some("123".into());
        input.usage_auto_interval = Some(5);
        let id = import_provider_from_deeplink(&state, parse_deeplink_url(&url(&input)).unwrap())
            .unwrap();
        let refreshed = ProviderService::list(&state, AppType::Pi).unwrap();
        let provider = &refreshed[&id];
        let script = provider
            .meta
            .as_ref()
            .unwrap()
            .usage_script
            .as_ref()
            .unwrap();
        assert_eq!(script.code, code);
        assert_eq!(script.enabled, separate_usage);
        assert_eq!(script.auto_query_interval, Some(5));
        assert_eq!(script.access_token, input.usage_access_token);
        assert_eq!(script.user_id, input.usage_user_id);
        if separate_usage {
            assert_eq!(script.api_key.as_deref(), Some("sk-usage-fixture"));
            assert_eq!(
                script.base_url.as_deref(),
                Some("https://usage.example.com")
            );
        } else {
            assert!(script.api_key.is_none());
            assert!(script.base_url.is_none());
        }
        assert_eq!(
            provider.resolve_usage_credentials(&AppType::Pi),
            (input.endpoint.unwrap(), input.api_key.unwrap())
        );
        assert!(models()["providers"][&id].get("usage_script").is_none());
        assert!(models()["providers"][&id].get("meta").is_none());
    }
}

#[test]
#[serial]
fn pi_presentation_metadata_survives_save_update_and_native_refresh() {
    let _home = TestHomeGuard::new();
    let _agent = TestAgentDir::new();
    let state = state();
    let parsed = parse_deeplink_url(&url(&request())).unwrap();
    let mut provider =
        crate::deeplink::provider::build_provider_from_request(&AppType::Pi, &parsed).unwrap();
    provider.id = "metadata-fixture".into();
    provider.icon = Some("pi".into());
    // Round-trip presentation fields through save, edit and native refresh.
    provider.meta = Some(
        serde_json::from_value(json!({
            "isPartner": true,
            "partnerPromotionKey": "fixture-partner",
            "iconUrl": "https://logo.example.com/Logo%2FOne.png?Case=A%2BB"
        }))
        .unwrap(),
    );
    let expected = serde_json::to_value(&provider.meta).unwrap();
    ProviderService::add(&state, AppType::Pi, provider.clone(), true).unwrap();
    provider.notes = Some("Updated fixture".into());
    ProviderService::update(&state, AppType::Pi, Some(&provider.id), provider.clone()).unwrap();
    let refreshed = ProviderService::list(&state, AppType::Pi).unwrap();
    assert_eq!(
        serde_json::to_value(&refreshed[&provider.id].meta).unwrap(),
        expected
    );
    assert_eq!(refreshed[&provider.id].icon, provider.icon);
    assert!(models()["providers"][&provider.id].get("iconUrl").is_none());
}

#[test]
#[serial]
fn pi_invalid_usage_config_is_rejected_by_existing_service_validation() {
    let _home = TestHomeGuard::new();
    let _agent = TestAgentDir::new();
    let state = state();
    let (original, _) = seed_native(&state);
    let mut input = request();
    input.enabled = Some(true);
    input.usage_auto_interval = Some(1441);
    let parsed = parse_deeplink_url(&url(&input)).unwrap();
    let error = import_provider_from_deeplink(&state, parsed)
        .unwrap_err()
        .to_string();
    assert!(error.contains("1440"));
    assert_eq!(models(), original);
    assert_eq!(state.db.get_all_providers("pi").unwrap().len(), 1);
}

#[test]
#[serial]
fn pi_malformed_or_unwritable_native_config_never_leaves_a_saved_import() {
    let _home = TestHomeGuard::new();
    let _agent = TestAgentDir::new();
    let state = state();
    let path = pi_config::get_pi_models_path().unwrap();
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    for bytes in ["{not-json", r#"{"providers":[]}"#] {
        fs::write(&path, bytes).unwrap();
        for enabled in [false, true] {
            let mut input = request();
            input.enabled = Some(enabled);
            assert!(import_provider_from_deeplink(
                &state,
                parse_deeplink_url(&url(&input)).unwrap()
            )
            .is_err());
            assert!(state.db.get_all_providers("pi").unwrap().is_empty());
            assert_eq!(fs::read_to_string(&path).unwrap(), bytes);
        }
    }
    fs::remove_file(&path).unwrap();
    // A directory at the file path fails on Windows too, unlike chmod-based tests.
    fs::create_dir(&path).unwrap();
    let mut input = request();
    input.enabled = Some(true);
    assert!(
        import_provider_from_deeplink(&state, parse_deeplink_url(&url(&input)).unwrap()).is_err()
    );
    assert!(path.is_dir());
    assert!(state.db.get_all_providers("pi").unwrap().is_empty());
}

#[test]
#[serial]
fn pi_database_failure_rolls_back_only_the_inserted_native_provider() {
    let _home = TestHomeGuard::new();
    let _agent = TestAgentDir::new();
    let state = state();
    let (original, untouched) = seed_native(&state);
    state.db.conn.lock().unwrap().execute_batch(
        "CREATE TEMP TRIGGER fail_pi_import BEFORE INSERT ON providers WHEN NEW.app_type = 'pi' BEGIN SELECT RAISE(ABORT, 'pi import test failure'); END;"
    ).unwrap();
    let mut input = request();
    input.enabled = Some(true);
    let error = import_provider_from_deeplink(&state, parse_deeplink_url(&url(&input)).unwrap())
        .unwrap_err()
        .to_string();
    assert!(error.contains("pi import test failure"));
    assert_eq!(models(), original);
    assert_eq!(state.db.get_all_providers("pi").unwrap().len(), 1);
    for (path, bytes) in untouched {
        assert_eq!(fs::read(path).unwrap(), bytes);
    }
}

#[test]
#[serial]
fn pi_rollback_preserves_a_concurrent_native_edit_and_reports_the_conflict() {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    let _home = TestHomeGuard::new();
    let _agent = TestAgentDir::new();
    let state = state();
    let (original, _) = seed_native(&state);
    let path = pi_config::get_pi_models_path().unwrap();
    state
        .db
        .conn
        .lock()
        .unwrap()
        .authorizer(Some(move |context: AuthContext<'_>| {
            if matches!(
                context.action,
                AuthAction::Insert {
                    table_name: "providers"
                }
            ) {
                let mut document: Value =
                    serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
                for (id, config) in document["providers"].as_object_mut().unwrap() {
                    if id != "anthropic" {
                        config["externalChange"] = json!(true);
                    }
                }
                fs::write(&path, serde_json::to_vec(&document).unwrap()).unwrap();
                Authorization::Deny
            } else {
                Authorization::Allow
            }
        }));
    let mut input = request();
    input.enabled = Some(true);
    let error = import_provider_from_deeplink(&state, parse_deeplink_url(&url(&input)).unwrap())
        .unwrap_err()
        .to_string();
    assert!(error.contains("native rollback failed"));
    assert!(error.contains("changed outside CC Switch"));
    assert_eq!(
        models()["providers"]["anthropic"],
        original["providers"]["anthropic"]
    );
    let document = models();
    let providers = document["providers"].as_object().unwrap();
    assert_eq!(providers.len(), 2);
    assert!(providers
        .iter()
        .any(|(id, config)| id != "anthropic" && config["externalChange"] == true));
    assert_eq!(state.db.get_all_providers("pi").unwrap().len(), 1);
}
