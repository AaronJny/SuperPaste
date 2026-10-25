use crate::shortcut_registration::{replace_shortcut, ShortcutRegistry};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

#[derive(Default)]
pub struct ShortcutManager {
    active: Mutex<Option<Shortcut>>,
    // Event callbacks must not wait for the configuration mutex while shortcut
    // registration is dispatching work to the main thread.
    active_token: AtomicU64,
}

impl ShortcutManager {
    pub fn is_active(&self, shortcut: &Shortcut) -> bool {
        self.active_token.load(Ordering::Acquire) == u64::from(shortcut.id()) + 1
    }

    pub fn set(&self, app: &AppHandle, shortcut: &str) -> Result<String, String> {
        let next: Shortcut = shortcut
            .parse()
            .map_err(|error| format!("Invalid shortcut: {error}"))?;
        let mut active = self
            .active
            .lock()
            .map_err(|_| "Shortcut state is unavailable")?;
        let next = replace_shortcut(&AppRegistry(app), *active, next)?;
        *active = Some(next);
        self.active_token
            .store(u64::from(next.id()) + 1, Ordering::Release);
        Ok(next.into_string())
    }
}

struct AppRegistry<'a>(&'a AppHandle);
impl ShortcutRegistry<Shortcut> for AppRegistry<'_> {
    fn is_registered(&self, shortcut: Shortcut) -> bool {
        self.0.global_shortcut().is_registered(shortcut)
    }
    fn register(&self, shortcut: Shortcut) -> Result<(), String> {
        self.0
            .global_shortcut()
            .register(shortcut)
            .map_err(|error| error.to_string())
    }
    fn unregister(&self, shortcut: Shortcut) -> Result<(), String> {
        self.0
            .global_shortcut()
            .unregister(shortcut)
            .map_err(|error| error.to_string())
    }
}

#[tauri::command]
pub async fn set_shortcut(app: AppHandle, shortcut: String) -> Result<String, String> {
    app.state::<ShortcutManager>().set(&app, &shortcut)
}
