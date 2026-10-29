package main

import (
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
)

type uploadFile struct {
	localPath  string
	remotePath string
	name       string
	size       int64
	modTime    int64
}

type uploadPlan struct {
	dirs    []string
	files   []uploadFile
	skipped []string
}

// buildUploadPlan scans a local file or folder and maps it below remoteDir.
func buildUploadPlan(localPath, remoteDir string) (uploadPlan, error) {
	info, err := os.Lstat(localPath)
	if err != nil {
		return uploadPlan{}, err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return uploadPlan{}, fmt.Errorf("symlink uploads are not supported: %s", localPath)
	}

	if !info.IsDir() {
		if !info.Mode().IsRegular() {
			return uploadPlan{}, fmt.Errorf("not a regular file or directory: %s", localPath)
		}

		name := filepath.Base(localPath)
		return uploadPlan{
			files: []uploadFile{{
				localPath:  localPath,
				remotePath: path.Join(remoteDir, name),
				name:       name,
				size:       info.Size(),
				modTime:    info.ModTime().UnixNano(),
			}},
		}, nil
	}

	rootName := filepath.Base(filepath.Clean(localPath))
	remoteRoot := path.Join(remoteDir, rootName)
	plan := uploadPlan{dirs: []string{remoteRoot}}

	err = filepath.WalkDir(localPath, func(currentPath string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if currentPath == localPath {
			return nil // the root directory was recorded above
		}

		relative, err := filepath.Rel(localPath, currentPath)
		if err != nil {
			return err
		}
		relative = filepath.ToSlash(relative)

		if entry.IsDir() {
			plan.dirs = append(plan.dirs, path.Join(remoteRoot, relative))
			return nil
		}
		if !entry.Type().IsRegular() {
			plan.skipped = append(plan.skipped, currentPath) // symlinks and special files
			return nil
		}

		fileInfo, err := entry.Info()
		if err != nil {
			return err
		}

		plan.files = append(plan.files, uploadFile{
			localPath:  currentPath,
			remotePath: path.Join(remoteRoot, relative),
			name:       path.Join(rootName, relative),
			size:       fileInfo.Size(),
			modTime:    fileInfo.ModTime().UnixNano(),
		})
		return nil
	})
	if err != nil {
		return uploadPlan{}, err
	}
	return plan, nil
}
