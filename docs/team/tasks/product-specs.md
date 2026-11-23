# Product specs and the API contract

Turning research into what engineers build: a spec per feature with its acceptance checks, and the API contract the apps and
services share (`contracts/api-v1.yaml`, `contracts/events.md`). The code stays with its owners; the spec says what done means.

| ID | Task | Needs | Source | Taken by | Status |
| --- | --- | --- | --- | --- | --- |
| SPEC-01 | Read `contracts/api-v1.yaml` and `contracts/events.md` against the running gateway; list what is missing or out of date | — | Team plan | | open |
| SPEC-02 | A spec template: the problem, who it is for, the screens, the API calls, the acceptance checks Hussein tests | — | Team plan | | open |
| SPEC-03 | Specs for the next web screens Reem builds, one per screen, from the [web rebuild](../../plans/web-rebuild/README.md) | SPEC-02 | Web rebuild | | open |
| SPEC-04 | Every new endpoint added to `api-v1.yaml` before its code, and reviewed in the pull request | SPEC-01 | Team plan | | open |
| SPEC-05 | The product numbers: sign-ups, active agencies, calls and texts per seat, as SQL queries with Omar, shown in Grafana with Eslam | — | Team plan | | open |
| SPEC-06 | Learn enough Go to read the `assistant` and `mcp` services and change their prompts and tool lists, with Mohammed | — | Team plan | | open |
