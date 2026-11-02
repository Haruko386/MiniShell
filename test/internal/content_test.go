package internal_test

import (
	"encoding/json"
	"testing"

	"github.com/Haruko386/MiniShell/internal/dto"
)

func TestWriteFileRequestDistinguishesMissingAndEmptyContent(t *testing.T) {
	var missing dto.GetFileRequest
	if err := json.Unmarshal([]byte(`{"version":"sha256:old"}`), &missing); err != nil {
		t.Fatal(err)
	}
	if missing.Content != nil {
		t.Fatal("missing content should decode to nil")
	}

	var empty dto.GetFileRequest
	if err := json.Unmarshal([]byte(`{"version":"sha256:old","content":""}`), &empty); err != nil {
		t.Fatal(err)
	}
	if empty.Content == nil || *empty.Content != "" {
		t.Fatalf("empty content should decode to an empty string, got %#v", empty.Content)
	}
}
