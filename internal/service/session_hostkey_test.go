package service

import (
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"net"
	"path/filepath"
	"testing"

	"golang.org/x/crypto/ssh"
)

func testHostKey(t *testing.T) ssh.PublicKey {
	t.Helper()

	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}

	signer, err := ssh.NewSignerFromKey(privateKey)
	if err != nil {
		t.Fatal(err)
	}
	return signer.PublicKey()
}

func TestReplaceChangedHostKey(t *testing.T) {
	path := filepath.Join(t.TempDir(), "known_hosts")
	oldKey := testHostKey(t)
	newKey := testHostKey(t)
	remote := &net.TCPAddr{IP: net.ParseIP("127.0.0.1"), Port: 2222}

	if err := appendKnownHost(path, "127.0.0.1:2222", oldKey); err != nil {
		t.Fatal(err)
	}

	callback, err := newHostKeyCallback("127.0.0.1", 2222, path, HostKeyPolicy{
		Mode:        HostKeyModeReplace,
		Fingerprint: ssh.FingerprintSHA256(newKey),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := callback("127.0.0.1:2222", remote, newKey); err != nil {
		t.Fatal(err)
	}

	callback, err = newHostKeyCallback("127.0.0.1", 2222, path, HostKeyPolicy{})
	if err != nil {
		t.Fatal(err)
	}
	err = callback("127.0.0.1:2222", remote, oldKey)
	var hostKeyErr *HostKeyError
	if !errors.As(err, &hostKeyErr) || !hostKeyErr.Changed {
		t.Fatalf("old key should be rejected after replacement, got %v", err)
	}
	if err := callback("127.0.0.1:2222", remote, newKey); err != nil {
		t.Fatalf("new key should be trusted after replacement: %v", err)
	}
}

func TestHostKeyOnceAndSave(t *testing.T) {
	path := filepath.Join(t.TempDir(), "known_hosts")
	key := testHostKey(t)
	remote := &net.TCPAddr{IP: net.ParseIP("127.0.0.1"), Port: 2222}

	callback, err := newHostKeyCallback("127.0.0.1", 2222, path, HostKeyPolicy{})
	if err != nil {
		t.Fatal(err)
	}
	err = callback("127.0.0.1:2222", remote, key)
	var hostKeyErr *HostKeyError
	if !errors.As(err, &hostKeyErr) || hostKeyErr.Changed {
		t.Fatalf("expected unknown host key, got %v", err)
	}

	callback, err = newHostKeyCallback("127.0.0.1", 2222, path, HostKeyPolicy{
		Mode:        HostKeyModeSave,
		Fingerprint: hostKeyErr.Fingerprint,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := callback("127.0.0.1:2222", remote, key); err != nil {
		t.Fatal(err)
	}

	callback, err = newHostKeyCallback("127.0.0.1", 2222, path, HostKeyPolicy{})
	if err != nil {
		t.Fatal(err)
	}
	if err := callback("127.0.0.1:2222", remote, key); err != nil {
		t.Fatalf("saved key should be trusted: %v", err)
	}
}
