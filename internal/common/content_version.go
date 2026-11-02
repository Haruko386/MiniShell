package common

import (
	"crypto/sha256"
	"encoding/hex"
)

func GetContentVersion(data []byte) string {
	sum := sha256.Sum256(data)
	return "sha256:" + hex.EncodeToString(sum[:])
}
