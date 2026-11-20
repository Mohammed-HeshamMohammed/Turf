module callerwhale/gateway

go 1.23

require (
	callerwhale/authverify v0.0.0
	callerwhale/runtimelog v0.0.0
)

replace callerwhale/authverify => ../../packages/go/authverify

replace callerwhale/runtimelog => ../../packages/go/runtimelog
