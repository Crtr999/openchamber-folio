# Always-on Carter companion

This stack serves the existing Open Carter desktop and mobile renderers from one authoritative OpenCode server. It keeps chats, generated files, model sign-ins and schedules in persistent Docker volumes. Caddy provides HTTPS and forwards streams/WebSockets. Only ports 80 and 443 are published. The model server, terminal and app port are not published separately.

This is deployment infrastructure, not a rented server or a live installation. No Mac conversations, credentials or files are copied automatically. Keep the old Mac installation intact until the chosen sessions and files have been explicitly migrated and checked. Opening a new instance alone does not migrate history.

## Requirements and price

Use an x86-64 Linux server with Docker Compose, a DNS name pointing to it and inbound TCP 80/443. Allow SSH only from trusted administration devices. Do not expose the Docker socket, OpenCode API or CarterBot port publicly.

As checked October 22, 2026, [DigitalOcean Basic](https://www.digitalocean.com/pricing/droplets) lists 2 vCPU / 4 GiB / 80 GiB at $24/month before tax and optional backup/storage charges. This is a conservative starting configuration for the app and moderate model-driven work, not a benchmark proving adequate capacity for several browser desktops. The coordinator alone may fit a smaller instance. [OVH US](https://us.ovhcloud.com/vps/) advertises 4 vCore / 8 GB / 75 GB from $8.50 per month; its Configure link selects `upfront12`, so budget $102 before tax for that advertised annual term, not $8.50 paid month to month. Confirm the actual checkout total and region before purchase. The [Hetzner cost-optimized page](https://www.hetzner.com/cloud/cost-optimized/) currently marks its smallest instances unavailable and did not expose reliable current prices in the retrieved page. Do not budget around an unverified $2 server for a full browser computer.

The Home Screen web app needs no Apple developer membership. Model calls can use eligible supported subscription access after sign-in; subscription usage limits still apply. The stack does not silently fall back to paid model APIs. No model credentials are supplied by the template. Local speech transcription requires its own installed speech model and RAM/CPU; it is not ChatGPT realtime voice.

## Prepare, validate, start

Copy `.env.example` to a private path outside this checkout, fill the real hostname/email and a long unique password, then restrict it to mode 600. DNS must resolve to the server before requesting a certificate.

```sh
node deploy/companion/check.mjs /absolute/private/carter.env
node deploy/companion/check.mjs /absolute/private/carter.env --docker
# Only after the host, DNS, price and data location are approved:
docker compose --env-file /absolute/private/carter.env -f deploy/companion/compose.yaml up -d --build
```

The preflight does not deploy. Do not run `docker compose config` without `--quiet` when sharing logs; it prints the resolved environment. Do not upload private environment files or browser profiles with the source. Build on a sufficiently sized builder. The October 22 local amd64 image test exhausted the test VM’s 4 GB during the production UI build, so that image was not verified running. Image-building memory requirements exceed steady-state requirements; hosting readiness still requires a successful image build and runtime test on the selected host or a larger builder.

## Connect both devices

1. Open `https://YOUR_HOST/mobile.html` on iPhone, unlock and use Safari Share → Add to Home Screen.
2. Open the installed Home Screen app and enable background notifications under Settings → Notifications. A permission request must follow a user tap. Confirm delivery while the app is closed.
3. Connect the Mac's remote-instance UI to this same server, or use its desktop web renderer. Authenticate through the supported instance flow. Do not point a second backend at a live database volume.
4. Verify the same session ID, an outgoing and incoming message, a document, diagram, file attachment, approval and a restarted connection on both devices. Only then migrate selected Mac-hosted work through a verified OpenCode export/import or database migration procedure, after preserving a backup. The applicable migration command/API must first be verified against the installed OpenCode version. An explicit migration plan is still required for local filesystem references and provider constraints.
5. Use Follow-ups on Home or mobile to enable project activity checks or create an opt-in daily responsibility in the selected project. The existing desktop Scheduled section owns the same row. Each run uses a bounded goal and ordinary tool approvals. Review results through its root conversation. Results persist in the Follow-ups inbox and their ordinary conversations. Activity checks debounce recent root conversations, run at most three times daily with a two-hour cooldown, and retain a daily scheduled backstop. Quiet hours, alert caps, delivery retries and exact-result deduplication reduce noise. Semantic opportunity ranking and vendor-specific webhooks remain outside this implementation.

## Speech shortcut

`/mobile.html?dictate=1` offers a microphone action after sign-in and loading the conversation. A user tap starts the existing composer dictation engine, preserving microphone consent and the draft's origin. Stop to insert or send using the existing dictation controls. Safari may require first-time microphone consent. Do not claim one-tap automatic microphone capture on a cold launch. An iPhone Shortcut can open this URL; creating an Action Button assignment is a device-side user choice.

## Virtual computer

Commands sent in a cloud-hosted conversation run through that server's configured tools and workspace. The existing app image includes terminal/runtime execution, not the separate CarterBot desktop image. Configure a separate private computer worker only after selecting its resource budget, tool policy and migration scope. Never substitute an arbitrary public computer URL or copy the local vault/token automatically. Remote viewing, takeover and mobile vault approval require a secure worker transport and real-device verification before claiming parity. Mac-only native integrations and local files remain on the Mac.

## Operations and recovery

Back up volumes with services stopped or an application-consistent database backup. Encrypt backups and test restoring to a separate instance. Never use `down -v` during an update. Retain a previously tested image tag and snapshot before replacing an image. Use `docker compose logs --tail=100` locally, redact private content before sharing. Healthcheck failures do not erase volumes. Restart policy handles process/host restarts, not exhausted storage or provider authentication expiry.

No service is guaranteed always available. Add disk/RAM and certificate-expiry monitoring before relying on deadlines. Push is an alert, while saved conversations and task state remain authoritative. Reconcile missed events on reconnect. Paid hosting, a real hostname, explicit provider sign-in and a physical iPhone test are required to finish deployment.

## Native iPhone push for a personal build

A free weekly iPhone install does not provide APNs push capability. A personal native build needs the user's Apple Developer team, its own registered App ID and App Group, and signing for the app plus its two extensions. The default source profile keeps upstream identifiers. The optional personal build settings documented in the mobile README configure a separate bundle and App Group; PersonalTeam.entitlements omits APNs for free weekly builds. Do not assume the public upstream push relay can send for a personal App ID.

The optional `native-push.compose.yaml` uses the existing direct Apple push implementation. Place the Apple P-256 `.p8` key in an owner-only file on the deployment host, outside the checkout. Set the four `CARTER_APNS_*`/`CARTER_IOS_BUNDLE_ID` values in the private environment file using `.env.example`. The bundle ID must match the signed app exactly. Do not paste a key into chat, images, environment examples or logs. The file is mounted only into the server, never the edge or iPhone app. On the Linux host it must be owned by UID 1000, the container app user, with mode 400 or 600. Local Compose bind-mounted secrets preserve file ownership; declaring a secret alone does not make a root-owned private file readable by the app. The Docker preflight rejects incompatible Linux ownership.

Validate first:

```sh
node deploy/companion/check.mjs /absolute/private/companion.env --native-push --docker
```

After the host purchase, deployment and credential-transfer steps are separately authorized, the optional profile uses:

```sh
docker compose --env-file /absolute/private/companion.env -f deploy/companion/compose.yaml -f deploy/companion/native-push.compose.yaml up -d
```

The preflight checks configuration, private file permissions and key type without printing private values or contacting Apple. It cannot prove that a key belongs to the configured Apple team or that a signed device can receive pushes. Verify background delivery and tap-to-session on a real iPhone before calling the service ready. Existing notification opt-in and enterprise content stripping remain in force.
