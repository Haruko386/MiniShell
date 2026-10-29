package service

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

const (
	HostKeyModeOnce    = "once"
	HostKeyModeSave    = "save"
	HostKeyModeReplace = "replace"
)

type HostKeyPolicy struct {
	Mode        string
	Fingerprint string
}

// HostKeyError carries the host key that needs user confirmation.
type HostKeyError struct {
	Host        string
	Port        int
	KeyType     string
	Fingerprint string
	Changed     bool
	Known       []string
}

func (e *HostKeyError) Error() string {
	if e.Changed {
		return fmt.Sprintf("host key mismatch for %s", net.JoinHostPort(e.Host, strconv.Itoa(e.Port)))
	}
	return fmt.Sprintf("unknown host key for %s", net.JoinHostPort(e.Host, strconv.Itoa(e.Port)))
}

func knownHostsFile() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("cannot get home directory: %v", err)
	}
	return filepath.Join(home, ".ssh", "known_hosts"), nil
}

func ensureKnownHostsFile(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return fmt.Errorf("create .ssh directory: %w", err)
	}

	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if errors.Is(err, os.ErrExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("create known_hosts: %w", err)
	}
	return file.Close()
}

func appendKnownHost(path, addr string, key ssh.PublicKey) error {
	file, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return fmt.Errorf("open known_hosts: %w", err)
	}
	defer file.Close()

	// Keep the new entry on its own line even if the file lacked a trailing newline.
	info, err := file.Stat()
	if err != nil {
		return fmt.Errorf("stat known_hosts: %w", err)
	}
	if info.Size() > 0 {
		if _, err := file.Seek(-1, io.SeekEnd); err != nil {
			return fmt.Errorf("seek known_hosts: %w", err)
		}
		var last [1]byte
		if _, err := file.Read(last[:]); err != nil {
			return fmt.Errorf("read known_hosts: %w", err)
		}
		if last[0] != '\n' {
			if _, err := file.Write([]byte("\n")); err != nil {
				return fmt.Errorf("write known_hosts: %w", err)
			}
		}
	}

	if _, err := fmt.Fprintln(file, knownhosts.Line([]string{addr}, key)); err != nil {
		return fmt.Errorf("write known_hosts: %w", err)
	}
	return nil
}

// replaceKnownHost removes saved keys of the same type for addr and appends key.
func replaceKnownHost(path, addr string, key ssh.PublicKey) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read known_hosts: %w", err)
	}

	target := knownhosts.Normalize(addr)
	lines := strings.Split(string(data), "\n")
	kept := make([]string, 0, len(lines)+1)

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			kept = append(kept, line)
			continue
		}

		fields := strings.Fields(trimmed)
		if len(fields) < 3 {
			kept = append(kept, line)
			continue
		}
		if fields[1] == key.Type() && knownHostPatternMatches(fields[0], target) {
			continue
		}
		kept = append(kept, line)
	}

	for len(kept) > 0 && strings.TrimSpace(kept[len(kept)-1]) == "" {
		kept = kept[:len(kept)-1]
	}
	kept = append(kept, knownhosts.Line([]string{addr}, key))

	mode := os.FileMode(0600)
	if info, statErr := os.Stat(path); statErr == nil {
		mode = info.Mode().Perm()
	}
	if err := os.WriteFile(path, []byte(strings.Join(kept, "\n")+"\n"), mode); err != nil {
		return fmt.Errorf("write known_hosts: %w", err)
	}
	return nil
}

func knownHostPatternMatches(pattern, target string) bool {
	if strings.HasPrefix(pattern, "|1|") {
		return hashedHostMatches(pattern, target)
	}

	for _, candidate := range strings.Split(pattern, ",") {
		if knownhosts.Normalize(strings.TrimPrefix(candidate, "!")) == target {
			return true
		}
	}
	return false
}

func hashedHostMatches(pattern, target string) bool {
	parts := strings.Split(pattern, "|")
	if len(parts) != 4 || parts[1] != "1" {
		return false
	}

	salt, err := base64.StdEncoding.DecodeString(parts[2])
	if err != nil {
		return false
	}
	hash, err := base64.StdEncoding.DecodeString(parts[3])
	if err != nil {
		return false
	}

	mac := hmac.New(sha1.New, salt)
	mac.Write([]byte(target))
	return hmac.Equal(mac.Sum(nil), hash)
}

func newHostKeyCallback(host string, port int, path string, policy HostKeyPolicy) (ssh.HostKeyCallback, error) {
	if err := ensureKnownHostsFile(path); err != nil {
		return nil, err
	}

	base, err := knownhosts.New(path)
	if err != nil {
		return nil, fmt.Errorf("cannot load known_hosts: %v", err)
	}

	return func(hostname string, remote net.Addr, key ssh.PublicKey) error {
		err := base(hostname, remote, key)
		if err == nil {
			return nil
		}

		var keyErr *knownhosts.KeyError
		if !errors.As(err, &keyErr) {
			return err
		}

		info := &HostKeyError{
			Host:        host,
			Port:        port,
			KeyType:     key.Type(),
			Fingerprint: ssh.FingerprintSHA256(key),
		}

		if len(keyErr.Want) > 0 {
			sameType := false
			for _, known := range keyErr.Want {
				if known.Key.Type() == key.Type() {
					sameType = true
					break
				}
			}

			if sameType {
				info.Changed = true
				for _, known := range keyErr.Want {
					info.Known = append(info.Known, ssh.FingerprintSHA256(known.Key))
				}

				if policy.Mode == HostKeyModeOnce || policy.Mode == HostKeyModeReplace {
					if policy.Fingerprint == "" || policy.Fingerprint != info.Fingerprint {
						return fmt.Errorf("host key fingerprint does not match confirmation")
					}
				}

				if policy.Mode == HostKeyModeReplace {
					if err := replaceKnownHost(path, net.JoinHostPort(host, strconv.Itoa(port)), key); err != nil {
						return fmt.Errorf("replace host key: %w", err)
					}
					return nil
				}
				if policy.Mode == HostKeyModeOnce {
					return nil
				}
				return info
			}
		}

		switch policy.Mode {
		case "":
			return info
		case HostKeyModeOnce:
			if policy.Fingerprint == "" || policy.Fingerprint != info.Fingerprint {
				return fmt.Errorf("host key fingerprint does not match confirmation")
			}
			return nil
		case HostKeyModeSave, HostKeyModeReplace:
			if policy.Fingerprint == "" || policy.Fingerprint != info.Fingerprint {
				return fmt.Errorf("host key fingerprint does not match confirmation")
			}
			if err := appendKnownHost(path, net.JoinHostPort(host, strconv.Itoa(port)), key); err != nil {
				return fmt.Errorf("save host key: %w", err)
			}
			return nil
		default:
			return fmt.Errorf("unsupported host key mode: %s", policy.Mode)
		}
	}, nil
}
