---
name: tests-validate-behavior-not-implementation
condition: ["toMatchSnapshot", "\\.mockReturnValue\\(", "\\.mockResolvedValue\\(", "\\.mockImplementation\\(\\(\\) =>"]
scope: [tool]
interrupt: false
repeat: once
globs: ["**/*.test.*", "**/*.spec.*", "**/test/**", "**/__tests__/**"]
---

# Tests must validate behavior, not the agent's assumptions

Snapshot tests and heavy mocks validate nothing — they freeze whatever the agent
generated (bugs and all) or test around the real code so thoroughly that nothing
real is tested. Assert against a known-good expected value, not the output of
the code under test. Mock only at stable seams; prefer integration tests against
a real (containerized) dependency.
