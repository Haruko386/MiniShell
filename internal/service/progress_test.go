package service

import (
	"errors"
	"io"
	"testing"
)

type partialWriter struct{}

func (partialWriter) Write(p []byte) (int, error) { return 2, io.ErrShortWrite }
func TestProgressWriterPartialWrite(t *testing.T) {
	var done, total int64
	w := progressWriter{dst: partialWriter{}, total: 10, report: func(d, n int64) { done, total = d, n }}
	n, err := w.Write([]byte("hello"))
	if n != 2 || !errors.Is(err, io.ErrShortWrite) {
		t.Fatalf("write: %d %v", n, err)
	}
	if done != 2 || total != 10 {
		t.Fatalf("progress: %d/%d", done, total)
	}
}
