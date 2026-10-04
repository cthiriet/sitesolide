// A fixture of bin/tests/cli-infer.test.ts: a Go server on the port the unit
// gives it. Never built.
package main

import (
	"net/http"
	"os"
)

func main() {
	http.HandleFunc("/api/hello", func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte("hello"))
	})
	http.ListenAndServe("127.0.0.1:"+os.Getenv("PORT"), nil)
}
