// Package proto stands in for gin's testdata/protoexample.
//
// It sits under a directory named testdata, so `go build ./...` never matches
// it and scip-go never indexes it — but an explicit import still reaches it,
// which is exactly what gin's tests do. That asymmetry is what made the Go
// provider refuse every project using the idiom.
package proto

type Payload struct {
	Value string
}

func Describe(payload Payload) string {
	return payload.Value
}
