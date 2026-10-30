package main

import (
	"os"
	"path/filepath"
	"sort"
	"testing"
)

func TestBuildUploadPlanDirectory(t *testing.T) {
	root := t.TempDir()
	folder := filepath.Join(root, "project")
	if err := os.MkdirAll(filepath.Join(folder, "empty"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(folder, "sub"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(folder, "a.txt"), []byte("a"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(folder, "sub", "b.txt"), []byte("bb"), 0600); err != nil {
		t.Fatal(err)
	}

	plan, err := buildUploadPlan(folder, "/remote")
	if err != nil {
		t.Fatal(err)
	}

	sort.Strings(plan.dirs)
	wantDirs := []string{"/remote/project", "/remote/project/empty", "/remote/project/sub"}
	if len(plan.dirs) != len(wantDirs) {
		t.Fatalf("unexpected dirs: %v", plan.dirs)
	}
	for i, want := range wantDirs {
		if plan.dirs[i] != want {
			t.Fatalf("unexpected dirs: %v", plan.dirs)
		}
	}

	files := make(map[string]uploadFile, len(plan.files))
	for _, file := range plan.files {
		files[file.name] = file
	}
	if got := files["project/a.txt"]; got.remotePath != "/remote/project/a.txt" || got.size != 1 {
		t.Fatalf("unexpected file: %+v", got)
	}
	if got := files["project/sub/b.txt"]; got.remotePath != "/remote/project/sub/b.txt" || got.size != 2 {
		t.Fatalf("unexpected file: %+v", got)
	}
}

func TestBuildUploadPlanSingleFile(t *testing.T) {
	root := t.TempDir()
	local := filepath.Join(root, "hello.txt")
	if err := os.WriteFile(local, []byte("hello"), 0600); err != nil {
		t.Fatal(err)
	}

	plan, err := buildUploadPlan(local, "/remote")
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.dirs) != 0 || len(plan.files) != 1 {
		t.Fatalf("unexpected plan: %+v", plan)
	}
	if plan.files[0].name != "hello.txt" || plan.files[0].remotePath != "/remote/hello.txt" {
		t.Fatalf("unexpected file: %+v", plan.files[0])
	}
}

func TestBuildUploadPlanSkipsSymlink(t *testing.T) {
	root := t.TempDir()
	folder := filepath.Join(root, "project")
	if err := os.MkdirAll(folder, 0755); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "target.txt")
	if err := os.WriteFile(target, []byte("target"), 0600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(folder, "link.txt")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlinks are not available: %v", err)
	}

	plan, err := buildUploadPlan(folder, "/remote")
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.files) != 0 {
		t.Fatalf("symlink should be skipped: %+v", plan.files)
	}
	if len(plan.skipped) != 1 || plan.skipped[0] != link {
		t.Fatalf("unexpected skipped files: %v", plan.skipped)
	}
}
