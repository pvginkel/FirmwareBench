# FirmwareBench

The bench lets an agent in a KubeCoder environment flash the ESP32 on the operator's desk and
read its serial log. It is a Node server and a Vite-built page, both in TypeScript. The page runs
in the operator's Chrome, holds the USB port through Web Serial, and connects to the server over a
WebSocket as "the holder". Agents call the server's HTTP API on localhost, and the server hands
each job to the holder.

It ships as the KubeCoder catalog service `bench`, a sidecar in the environment's pod.

## Layout

- `src/server/`: the server. The page port (`page-server.ts`), the holder connection
  (`holder-hub.ts`), the agent API (`agent-api.ts`, errors in `errors.ts`), the build directory
  check (`build-dir.ts`) and the log writer (`serial-log.ts`).
- `src/page/`: the page. A dedicated worker keeps the port, runs the monitor and runs esptool-js
  during a flash.
- `src/shared/protocol.ts`: the messages between the holder and the server.
- `test/`: the suites. `scripts/e2e-smoke.mjs`: the end-to-end check.
- `deploy/catalog-entry.yaml`: the service's catalog entry.

## Running it in dev

In a KubeCoder environment with the `frontend` toolchain, use the curated verbs from the repo
root: `kc project setup`, `kc project build`, `kc project test` and `kc project lint`. By hand,
the same steps are `npm ci`, `npm run build`, and then `npm start`, each through
`cexec frontend`. `npm run dev` runs the server from source instead of from `dist/`.

The server reads these environment variables:

| Variable | Default | What it is |
|---|---|---|
| `BENCH_PAGE_PORT` | `3520` | The page, the holder's WebSocket and the job images, on all interfaces. |
| `BENCH_API_PORT` | `3521` | The agent API, on `127.0.0.1` only. |
| `BENCH_PAGE_DIR` | `dist/page` | The built page. |
| `BENCH_ALLOWED_ORIGINS` | none | Origins a holder may connect from besides the page's own, comma-separated, such as Vite's dev server. |
| `BENCH_WORK_ROOT` | `/work` | Build directories must be under this. |
| `BENCH_LOG_DIR` | `/work/.bench` | Where `serial.log` goes. |

Web Serial needs a secure context, so the operator's browser must reach the page over https. The
environment gets that from a `ports:` entry named `bench` on 3520 with `sslOffload: true`, which
serves the page at `https://bench.<env-id>.home`. A server started through `cexec` is not
supervised and dies on a pod restart.

## The API

The agent API has five calls: `POST /flash`, `GET /status`, `GET /log`, `POST /reset` and
`POST /console`. Every failure is a non-2xx status with a JSON body that carries an error code.
The reference for the calls, their answers, the error codes and the log format is the
`instructions` text in `deploy/catalog-entry.yaml`, which is what agents read through
`kc env describe`.

## Tests

`npm test` runs the Vitest suites. The server is tested against a scripted holder, and the page's
engine against a fake Web Serial port and a scripted server. `npm run lint` runs ESLint and then
tsc over the server, the page and the tests.

`scripts/e2e-smoke.mjs` drives the built page in headless Chromium against a real server on its
own ports, 3530 and 3531, so it can run beside a live bench. It is not part of `npm test`; its
header has the command. No suite covers esptool-js against a real chip; that is checked on the
board.

## Release

The `Jenkinsfile` is the Jenkins job `FirmwareBench`, triggered by a push to `main`. It lints and
tests the repo, then builds the image and pushes it as `registry:5000/firmware-bench:<build
number>` and `registry:5000/firmware-bench:latest`.

The catalog entry lives in KubeCoderDeploy's `chart/values.yaml`, under
`controllerConfig.services`. `deploy/catalog-entry.yaml` is its source: change it here and copy it
there. The entry names the `latest` tag, which each environment start resolves to a digest, so an
environment runs a new build after its next start. A change to the entry itself reaches dev when
KubeCoderDeploy's `main` syncs, and prd when the operator promotes it.

## Design

Why the bench is built this way, and how it was built: `docs/remote-flashing-design.md` (the
options, the spikes' answers in §9 and the decisions) and `docs/remote-flashing-plan.md` (the
build plan). Both came from ToiletAutomation, the first project to use the bench.
