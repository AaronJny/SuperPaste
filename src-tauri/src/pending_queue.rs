use std::collections::VecDeque;

const MAX_PENDING_ITEMS: usize = 256;
const MAX_PENDING_TEXT_BYTES: usize = 32 * 1024 * 1024;

pub trait PendingPayload {
    fn id(&self) -> &str;
    fn text_bytes(&self) -> usize;
}

/// Reading a batch never consumes it. Only the consumer's persistence
/// acknowledgment releases data and backpressure.
pub struct PendingQueue<T> {
    items: VecDeque<T>,
    text_bytes: usize,
}

impl<T> Default for PendingQueue<T> {
    fn default() -> Self {
        Self {
            items: VecDeque::new(),
            text_bytes: 0,
        }
    }
}

impl<T: PendingPayload + Clone> PendingQueue<T> {
    pub fn is_full(&self) -> bool {
        self.items.len() >= MAX_PENDING_ITEMS || self.text_bytes >= MAX_PENDING_TEXT_BYTES
    }

    pub fn push(&mut self, payload: T) {
        self.text_bytes += payload.text_bytes();
        self.items.push_back(payload);
    }

    pub fn snapshot(&self) -> Vec<T> {
        self.items.iter().cloned().collect()
    }

    pub fn acknowledge(&mut self, id: &str) {
        if let Some(index) = self.items.iter().position(|item| item.id() == id) {
            if let Some(item) = self.items.remove(index) {
                self.text_bytes -= item.text_bytes();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone)]
    struct Item {
        id: String,
        size: usize,
    }
    impl PendingPayload for Item {
        fn id(&self) -> &str {
            &self.id
        }
        fn text_bytes(&self) -> usize {
            self.size
        }
    }
    fn item(id: &str) -> Item {
        Item {
            id: id.into(),
            size: 6,
        }
    }

    #[test]
    fn startup_snapshots_keep_data_until_acknowledged() {
        let mut queue = PendingQueue::default();
        queue.push(item("first"));
        queue.push(item("second"));
        assert_eq!(queue.snapshot().len(), 2);
        assert_eq!(queue.snapshot().len(), 2);
        queue.acknowledge("first");
        queue.acknowledge("first");
        queue.acknowledge("unknown");
        assert_eq!(queue.snapshot()[0].id, "second");
        assert_eq!(queue.text_bytes, 6);
    }

    #[test]
    fn acknowledging_snapshot_keeps_items_captured_during_persistence() {
        let mut queue = PendingQueue::default();
        queue.push(item("first"));
        let snapshot = queue.snapshot();
        queue.push(item("second"));
        for item in snapshot {
            queue.acknowledge(&item.id);
        }
        assert_eq!(queue.snapshot().len(), 1);
        assert_eq!(queue.snapshot()[0].id, "second");
    }

    #[test]
    fn backpressure_keeps_all_captures_until_acknowledged() {
        let mut queue = PendingQueue::default();
        for id in 0..MAX_PENDING_ITEMS {
            queue.push(item(&id.to_string()));
        }
        assert!(queue.is_full());
        assert_eq!(queue.snapshot().len(), MAX_PENDING_ITEMS);
        queue.acknowledge("0");
        assert!(!queue.is_full());
        assert_eq!(queue.snapshot().len(), MAX_PENDING_ITEMS - 1);
    }

    #[test]
    fn byte_backpressure_is_released_after_acknowledgment() {
        let mut queue = PendingQueue::default();
        queue.push(Item {
            id: "large".into(),
            size: MAX_PENDING_TEXT_BYTES,
        });
        assert!(queue.is_full());
        queue.acknowledge("large");
        assert_eq!(queue.text_bytes, 0);
        assert!(!queue.is_full());
    }
}
