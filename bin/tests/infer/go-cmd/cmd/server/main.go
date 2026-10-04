// A fixture of bin/tests/cli-infer.test.ts: the main package under cmd/, and
// a server that ignores PORT. Never built.
package main

import "net/http"

func main() {
	http.ListenAndServe("127.0.0.1:8080", nil)
}
