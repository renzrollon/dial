## REMOVED Requirements

### Requirement: The narrate-endpoint check reports the resolved endpoint without a network call
**Reason**: A check that reports `ok` while nothing is listening hid the reason every session ended without a narrative.
**Migration**: Replaced by `The narrate-endpoint check reports the resolved endpoint and whether anything is listening`. A resolved endpoint with nothing listening is now `warn`, which does not change doctor's exit code.

## ADDED Requirements

### Requirement: The narrate-endpoint check reports the resolved endpoint and whether anything is listening
The `narrate-endpoint` check SHALL resolve the endpoints the way `dial narrate` does. When a URL and a model resolve it SHALL try a TCP connection of at most 1 second to the primary and to the fallback, sending no data and only to loopback addresses. It SHALL be `ok` with the detail `<url> (<model>)` when either accepts, else `warn` with the detail `<url> (<model>): nothing is listening`. Otherwise it SHALL be `skip`. No API key value SHALL be printed.

#### Scenario: Endpoint from pi's models file
- **WHEN** `~/.pi/agent/models.json` holds provider `mtplx` with `baseUrl` `http://127.0.0.1:8000/v1`, `apiKey` `sk-local-123` and the first model `mtplx-qwen38-27b-optimized-speed`, the registry has no `narrate` block, and that address accepts connections
- **THEN** the `narrate-endpoint` check is `ok` with the detail `http://127.0.0.1:8000/v1 (mtplx-qwen38-27b-optimized-speed)`, and neither the text nor the JSON report contains `sk-local-123`

#### Scenario: Registry override wins
- **WHEN** the models file resolves as above, the registry's `narrate` holds `url` `http://127.0.0.1:9000/v1` and `model` `qwen3.6`, and that address accepts connections
- **THEN** the detail is `http://127.0.0.1:9000/v1 (qwen3.6)`

#### Scenario: Nothing configured
- **WHEN** there is no `~/.pi/agent/models.json` and the registry has no `narrate` block
- **THEN** the `narrate-endpoint` check is `skip` with the detail `no narrate endpoint configured`, and doctor opens no connection

#### Scenario: Nothing is listening
- **WHEN** the endpoint resolves and neither it nor the fallback accepts a connection
- **THEN** the check is `warn` with the detail `http://127.0.0.1:8000/v1 (mtplx-qwen38-27b-optimized-speed): nothing is listening`, its evidence names each address as `not listening`, its fix says to start the local model server, and doctor's exit code is unchanged

#### Scenario: Only the fallback is listening
- **WHEN** the primary refuses the connection and the fallback accepts it
- **THEN** the check is `ok` and its evidence names the primary as `not listening` and the fallback as `listening`

#### Scenario: A non-local endpoint is not contacted
- **WHEN** the registry's `narrate` holds `url` `https://models.example.com/v1` and the fallback refuses the connection
- **THEN** doctor opens no connection to `models.example.com`, the evidence names it as `not a local endpoint`, and the check is `warn`

#### Scenario: A hanging address does not hold doctor up
- **WHEN** a loopback address accepts no connection and does not refuse one
- **THEN** that attempt ends after 1 second and counts as `not listening`

#### Scenario: A failed probe does not stop doctor
- **WHEN** resolving or probing the endpoints throws an unexpected error
- **THEN** doctor still prints its full report, `narrate-endpoint` carries no listening evidence, and the exit code depends only on the other checks

#### Scenario: Doctor still creates no home
- **WHEN** doctor runs with a missing Dial home and a resolved endpoint
- **THEN** the home has not been created afterwards
