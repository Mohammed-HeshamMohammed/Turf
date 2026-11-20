openapi: 3.0.3
info:
  title: Caller Whale __TITLE__
  version: 0.1.0
  description: __DESC__
paths:
  /healthz:
    get:
      summary: Is the service running
      responses:
        "200":
          description: Running
          content:
            application/json:
              schema:
                type: object
                required: [ok, service]
                properties:
                  ok: { type: boolean }
                  service: { type: string, example: __NAME__ }
  /version:
    get:
      summary: The running version
      responses:
        "200":
          description: Version
          content:
            application/json:
              schema:
                type: object
                required: [service, version]
                properties:
                  service: { type: string }
                  version: { type: string, example: 0.1.0 }
