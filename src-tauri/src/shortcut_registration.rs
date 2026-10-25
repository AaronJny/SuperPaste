pub trait ShortcutRegistry<S> {
    fn is_registered(&self, shortcut: S) -> bool;
    fn register(&self, shortcut: S) -> Result<(), String>;
    fn unregister(&self, shortcut: S) -> Result<(), String>;
}

pub fn replace_shortcut<S: Copy + Eq>(
    registry: &impl ShortcutRegistry<S>,
    previous: Option<S>,
    next: S,
) -> Result<S, String> {
    if previous == Some(next) {
        return Ok(next);
    }
    // Keep the working shortcut when the replacement is unavailable. An
    // inactive registration can remain after an OS rollback failure; reusing
    // it allows retry while the event handler filters it out in the meantime.
    if !registry.is_registered(next) {
        registry
            .register(next)
            .map_err(|error| format!("Cannot register shortcut: {error}"))?;
    }
    if let Some(previous) = previous {
        if let Err(error) = registry.unregister(previous) {
            return match registry.unregister(next) {
                Ok(()) => Err(format!("Cannot replace shortcut; previous shortcut retained: {error}")),
                Err(rollback) => Err(format!(
                    "Cannot replace shortcut; previous shortcut retained: {error}. Replacement cleanup failed: {rollback}"
                )),
            };
        }
    }
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashSet;

    #[derive(Default)]
    struct Registry {
        registered: RefCell<HashSet<u32>>,
        actions: RefCell<Vec<(&'static str, u32)>>,
        fail_register: Option<u32>,
        fail_unregister: HashSet<u32>,
    }
    impl ShortcutRegistry<u32> for Registry {
        fn is_registered(&self, shortcut: u32) -> bool {
            self.registered.borrow().contains(&shortcut)
        }
        fn register(&self, shortcut: u32) -> Result<(), String> {
            self.actions.borrow_mut().push(("register", shortcut));
            if self.fail_register == Some(shortcut) {
                return Err("conflict".into());
            }
            self.registered.borrow_mut().insert(shortcut);
            Ok(())
        }
        fn unregister(&self, shortcut: u32) -> Result<(), String> {
            self.actions.borrow_mut().push(("unregister", shortcut));
            if self.fail_unregister.contains(&shortcut) {
                return Err("OS failure".into());
            }
            self.registered.borrow_mut().remove(&shortcut);
            Ok(())
        }
    }

    #[test]
    fn replacement_is_registered_before_removing_previous() {
        let registry = Registry::default();
        registry.registered.borrow_mut().insert(1);
        assert_eq!(replace_shortcut(&registry, Some(1), 2), Ok(2));
        assert_eq!(
            *registry.actions.borrow(),
            vec![("register", 2), ("unregister", 1)]
        );
        assert!(registry.is_registered(2));
        assert!(!registry.is_registered(1));
    }

    #[test]
    fn registration_failure_preserves_previous_shortcut() {
        let registry = Registry {
            fail_register: Some(2),
            ..Registry::default()
        };
        registry.registered.borrow_mut().insert(1);
        assert!(replace_shortcut(&registry, Some(1), 2).is_err());
        assert_eq!(*registry.actions.borrow(), vec![("register", 2)]);
        assert!(registry.is_registered(1));
    }

    #[test]
    fn unregister_failure_rolls_back_the_replacement() {
        let registry = Registry {
            fail_unregister: HashSet::from([1]),
            ..Registry::default()
        };
        registry.registered.borrow_mut().insert(1);
        assert!(replace_shortcut(&registry, Some(1), 2).is_err());
        assert!(registry.is_registered(1));
        assert!(!registry.is_registered(2));
        assert_eq!(
            *registry.actions.borrow(),
            vec![("register", 2), ("unregister", 1), ("unregister", 2)]
        );
    }

    #[test]
    fn rollback_failure_is_reported_and_can_be_retried() {
        let mut registry = Registry {
            fail_unregister: HashSet::from([1, 2]),
            ..Registry::default()
        };
        registry.registered.borrow_mut().insert(1);
        let error = replace_shortcut(&registry, Some(1), 2).unwrap_err();
        assert!(error.contains("cleanup failed"));
        assert!(registry.is_registered(1));
        assert!(registry.is_registered(2));
        registry.fail_unregister.clear();
        assert_eq!(replace_shortcut(&registry, Some(1), 2), Ok(2));
        assert!(!registry.is_registered(1));
    }

    #[test]
    fn equivalent_shortcut_requires_no_os_changes() {
        let registry = Registry::default();
        replace_shortcut(&registry, Some(1), 1).unwrap();
        assert!(registry.actions.borrow().is_empty());
    }
}
