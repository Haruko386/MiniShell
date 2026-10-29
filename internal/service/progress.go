package service

import (
	"io"
	"time"
)

type progressReader struct {
	src      io.Reader
	total    int64
	read     int64
	last     time.Time
	interval time.Duration
	report   func(int64, int64)
}

func (r *progressReader) Read(p []byte) (int, error) {
	n, err := r.src.Read(p)
	if n > 0 {
		r.read += int64(n)

		now := time.Now()
		if r.last.IsZero() || now.Sub(r.last) >= r.interval || err != nil {
			r.last = now
			r.report(r.read, r.total)
		}
	}
	return n, err
}
