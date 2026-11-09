'use strict';
// Called from the e2e tests through the DevTools protocol.
self.findByName = async (name) => (await chrome.management.getAll()).find((e) => e.name === name) || null;
self.setEnabled = (id, enabled) => chrome.management.setEnabled(id, enabled);
