# Stage 1B Docker API Identity Query Authorization Proposal

**NOT AUTHORIZED — owner approval required.** Stage 1A bounded local provenance was [accepted with exception](STAGE_1A_OWNER_ACCEPTANCE_EXCEPTION.md). Internal Docker ID remains unverified. Phase 1 R1 remains **BLOCKED / NOT ACCEPTED**.

## Exact request and authority

Propose one read-only HTTP GET `/info` through the exact local Unix socket `/run/docker.sock` inside Ubuntu WSL2 as operator jeysi. This uses existing rootful Docker socket authority, not sudo, a container, network TCP endpoint or default Docker CLI context. Docker context is historically default but is not consulted by this command. No DOCKER_HOST, DOCKER_CONTEXT, HTTP proxy, Docker credential store or CLI version negotiation is involved. The HTTP host localhost is only the request header/URI authority; transport is the explicit Unix socket.

One request only: no `/version`, `/containers`, image/network/volume list, redirects or automatic retries. `/info` is a broad daemon metadata response even though the returned summary below is restricted. It can contain workload counts, labels, registry addresses and proxy/configuration details in process memory; owner approval must cover this transient read. Do not print/store the raw response. This is daemon self-reporting, not independent authentication. Existing socket access is rootful authority even when this single intended API call is read-only.

## Proposed command, not for execution

Use Bash; run once only after the owner approves this exact document/hash and a fresh window. Existing curl and Python3 must be available; do not install tools under this grant. The ordinary-user pipeline prints only selected fields or a generic failure. No output redirection or evidence files.

```sh
(set -o pipefail; curl --unix-socket /run/docker.sock --noproxy '*' --proto '=http' --max-time 5 --max-filesize 65536 --silent --show-error --fail http://localhost/info | python3 -B -c 'import json,sys; raw=sys.stdin.buffer.read(65537); fields={"ID":str,"Name":str,"ServerVersion":str,"OSType":str,"Architecture":str,"DockerRootDir":str,"SecurityOptions":list};
try:
    if len(raw)>65536: raise ValueError()
    data=json.loads(raw)
    if not isinstance(data,dict) or any(k not in data or not isinstance(data[k],t) for k,t in fields.items()): raise ValueError()
    if any(not isinstance(v,str) for v in data["SecurityOptions"]): raise ValueError()
    if not data["ID"] or data["OSType"]!="linux": raise ValueError()
    print(json.dumps({k:data[k] for k in fields},ensure_ascii=True))
except Exception:
    print("Identity response rejected; no raw response retained.",file=sys.stderr); sys.exit(2)')
```

Immediately after the pipeline, before any other command:

```sh
printf 'exit_status=%s\n' "$?"
```

Bash pipefail makes curl failure nonzero even if parsing succeeds. curl has a five-second request deadline and a 64KiB response limit; the parser separately enforces that size and fixed field types. If HTTP status/error, timeout, oversize, missing/invalid fields, permission denial, unknown transport or schema occurs, stop without retry or an alternate path. No interactive authentication or elevation. Do not paste prose into the terminal or combine this with later stages.

## Preconditions and interpretation

Owner must explicitly select whether Codex or the owner executes this one request, approve a new date/window in Asia/Manila, confirm existing endpoint/provenance has not knowingly changed since Stage1A, and confirm evidence custody/recovery availability. Stage1A evidence is historical; this proposal adds no implicit process reinspection. Any known restart, executable/socket replacement, endpoint change or provenance uncertainty blocks the query pending reassessment. No previous sudo grant is reusable here.

Successful field/schema checks establish an **observed daemon-reported identity baseline**, not a comparison against an independently known Docker ID: none has been supplied. Compare Linux/native Engine consistency, reported version and security options with the accepted owner evidence; rootless report or unexplained discrepancy is INCONCLUSIVE, not a reason to switch endpoints. A mismatch or unavailable evidence prevents later inventory. A successful API response alone does not prove resources belong to Omnis or authorize Stage1C.

Selected Name, ID, DockerRootDir and SecurityOptions can still contain sensitive host paths/identifiers. Owner approves private in-session handling, reviews output before sharing, and redacts unrelated names/paths. Codex retains only necessary identity conclusions; no raw body, registry/proxy fields, credentials, environments, application rows or logs. Error text could expose local transport details; stop and redact unexpected sensitive content.

## STAGE 1B — OWNER AUTHORIZATION REQUEST

- Target/operator: Ubuntu WSL2 / jeysi; exact socket `/run/docker.sock`; accepted bounded Stage1A evidence with documented exception.
- Execution actor (owner or Codex): **PENDING OWNER CHOICE**.
- Allowlist: exact one-request pipeline plus immediate status helper above. No sudo, retries, redirects, default context selection, credentials, resource lists or filesystem evidence writes.
- Date/time/window: **PENDING OWNER APPROVAL**, Asia/Manila.
- Evidence: minimized selected JSON in-session only; no persistent files. Acknowledge transient full `/info` body read and rootful socket authority.
- Recovery contact/availability: previously private arrangement; **PENDING RECONFIRMATION**.
- Stop: known provenance drift, endpoint mismatch, denied access, errors, oversize/invalid response, identity inconsistency, sensitive exposure or expired window.
- Scope: Stage1B API identity observation only. Stage1C inventory and Stages2–4 remain unauthorized. No Docker lifecycle/service/database/provider operations, deployment or cleanup.
- Status: **NOT GRANTED**. Approve exact reviewed hash and pending fields before execution. A source merge grants no runtime permission.
