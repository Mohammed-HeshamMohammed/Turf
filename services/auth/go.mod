module callerwhale/auth

go 1.26.0

require (
	github.com/coreos/go-oidc/v3 v3.21.0
	github.com/golang-jwt/jwt/v5 v5.3.1
	github.com/google/uuid v1.6.0
	github.com/jackc/pgx/v5 v5.13.0
	github.com/pquerna/otp v1.5.0
	github.com/rs/cors v1.11.1
	golang.org/x/oauth2 v0.38.0
)

require golang.org/x/image v0.48.0

require (
	callerwhale/runtimelog v0.0.0
	github.com/boombuler/barcode v1.0.1-0.20190219062509-6c824513bacc // indirect
	github.com/go-jose/go-jose/v4 v4.1.6 // indirect
	github.com/jackc/pgpassfile v1.0.0 // indirect
	github.com/jackc/pgservicefile v0.0.0-20240606120523-5a60cdf6a761 // indirect
	github.com/jackc/puddle/v2 v2.2.3 // indirect
	golang.org/x/sync v0.25.0 // indirect
	golang.org/x/text v0.44.0 // indirect
)

replace callerwhale/runtimelog => ../../packages/go/runtimelog
