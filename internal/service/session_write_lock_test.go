package service

import (
	"testing"
	"time"
)

func TestSessionWriteLocks(t *testing.T) {
	s := &sshSession{}
	unlock := s.lockWritePath("/one")
	other := s.lockWritePath("/two")
	other()

	waiting := make(chan struct{})
	acquired := make(chan struct{})
	go func() {
		close(waiting)
		release := s.lockWritePath("/one")
		close(acquired)
		release()
	}()
	<-waiting
	select {
	case <-acquired:
		t.Fatal("same path acquired before release")
	default:
	}
	unlock()
	select {
	case <-acquired:
	case <-time.After(2 * time.Second):
		t.Fatal("waiting save did not acquire released lock")
	}
}

func TestWriteLocksAreSessionScoped(t *testing.T) {
	first, second := &sshSession{}, &sshSession{}
	release := first.lockWritePath("/file")
	defer release()
	done := make(chan struct{})
	go func() {
		unlock := second.lockWritePath("/file")
		unlock()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("different session blocked")
	}
}
