package service

import (
	"testing"
	"time"
)

func TestSessionWriteLocks(t *testing.T) {
	s := NewSessionSvr()
	id := connectionIdentity{host: "example", port: 22, username: "user"}
	unlock := s.lockWritePath(id, "/one")
	other := s.lockWritePath(id, "/two")
	other()

	waiting := make(chan struct{})
	acquired := make(chan struct{})
	go func() {
		close(waiting)
		release := s.lockWritePath(id, "/one")
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

func TestWriteLocksShareConnectionIdentity(t *testing.T) {
	s := NewSessionSvr()
	first := &sshSession{identity: connectionIdentity{host: "example", port: 22, username: "user"}}
	second := &sshSession{identity: first.identity}
	release := s.lockWritePath(first.identity, "/file")
	other := s.lockWritePath(connectionIdentity{host: "other", port: 22, username: "user"}, "/file")
	other()
	done := make(chan struct{})
	go func() {
		unlock := s.lockWritePath(second.identity, "/file")
		unlock()
		close(done)
	}()
	select {
	case <-done:
		t.Fatal("same connection and path should block")
	case <-time.After(50 * time.Millisecond):
	}
	release()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("same connection save did not proceed after release")
	}
}

func TestSaveSlotWaitEndsWhenSessionCloses(t *testing.T) {
	sess := &sshSession{closed: make(chan struct{}), saveSlot: make(chan struct{}, 1)}
	sess.saveSlot <- struct{}{}
	s := NewSessionSvr()
	s.sessions["id"] = sess
	done := make(chan error, 1)
	go func() {
		_, err := s.WriteFileContent("id", NewFileSvr(), "/file", "version", "content")
		done <- err
	}()
	close(sess.closed)
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("expected closed session error")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("save slot wait did not end")
	}
}
