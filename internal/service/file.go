package service

import (
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/Haruko386/MiniShell/internal/entity"
	"github.com/pkg/sftp"
)

type FileSvr struct{}

func NewFileSvr() *FileSvr {
	return &FileSvr{}
}

// Delete removes a non-directory entry without following symbolic links.
func (s *FileSvr) Delete(client *sftp.Client, remotePath string) error {
	if !path.IsAbs(remotePath) || path.Clean(remotePath) == "/" {
		return fmt.Errorf("invalid remote file path")
	}

	cleanPath := path.Clean(remotePath)
	if cleanPath == "/" || cleanPath != remotePath {
		return fmt.Errorf("invalid remote file path")
	}

	info, err := client.Lstat(remotePath)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return client.Remove(remotePath)
	}

	children, err := client.ReadDir(remotePath)
	if err != nil {
		return fmt.Errorf("read recursively: %w", err)
	}

	for _, child := range children {
		childPath := path.Join(remotePath, child.Name())
		if err = s.Delete(client, childPath); err != nil {
			return fmt.Errorf("delete file %s: %w", childPath, err)
		}
	}

	if err = client.RemoveDirectory(remotePath); err != nil {
		return fmt.Errorf("remove directory %s failed: %w", remotePath, err)
	}
	return nil
}

var sftpConcurrency = 128

func init() {
	if raw := os.Getenv("MINISHELL_SFTP_CONCURRENCY"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 {
			sftpConcurrency = n
		}
	}
}

func (s *FileSvr) List(client *sftp.Client, dirPath string) (string, []entity.FileEntry, error) {
	if !path.IsAbs(dirPath) {
		return "", nil, fmt.Errorf("%s is not an absolute path", dirPath)
	}

	// get real path from remote server
	realPath, err := client.RealPath(dirPath)
	if err != nil {
		return "", nil, fmt.Errorf("resolve remote path error: %w", err)
	}

	files, err := client.ReadDir(realPath)
	if err != nil {
		return "", nil, fmt.Errorf("read dir error: %w", err)
	}

	entries := make([]entity.FileEntry, 0, len(files))

	for _, file := range files {
		fileType := "file"
		if file.IsDir() {
			fileType = "directory"
		}

		entries = append(entries, entity.FileEntry{
			Name:       file.Name(),
			Type:       fileType,
			Size:       file.Size(),
			ModifiedAt: file.ModTime(),
		})
	}
	return realPath, entries, nil
}

// UploadFile pairs an uploaded file with its path relative to the target directory.
type UploadFile struct {
	Header   *multipart.FileHeader
	Relative string
}

func (s *FileSvr) Upload(client *sftp.Client, dirPath string, files []UploadFile) error {
	if !path.IsAbs(dirPath) {
		return fmt.Errorf("%s is not an absolute path", dirPath)
	}

	realPath, err := client.RealPath(dirPath)
	if err != nil {
		return fmt.Errorf("resolve remote path error: %w", err)
	}

	for _, file := range files {
		if err := uploadOne(client, realPath, file); err != nil {
			return err
		}
	}
	return nil
}

// UploadLocal keeps the existing API for callers that do not need progress.
func (s *FileSvr) UploadLocal(client *sftp.Client, localPath, remotePath string) error {
	return s.UploadLocalWithProgress(client, localPath, remotePath, nil)
}

// UploadLocalWithProgress reports bytes read from the local file.
func (s *FileSvr) UploadLocalWithProgress(client *sftp.Client, localPath, remotePath string, progress func(int64, int64)) error {
	return s.UploadLocalChecked(client, localPath, remotePath, path.Dir(remotePath), nil, progress)
}

type SourceSnapshot struct {
	Size    int64
	ModTime int64
}

func (s *FileSvr) UploadLocalChecked(client *sftp.Client, localPath, remotePath, remoteBase string, expected *SourceSnapshot, progress func(int64, int64)) error {
	if !path.IsAbs(remotePath) {
		return fmt.Errorf("%s is not an absolute path", remotePath)
	}

	file, info, err := openUploadSource(localPath, expected)
	if err != nil {
		return err
	}
	defer file.Close()

	if progress != nil {
		progress(0, info.Size())
	}

	remoteParent, err := ensureRemoteDirectory(client, remoteBase, path.Dir(remotePath))
	if err != nil {
		return fmt.Errorf("create remote dir: %w", err)
	}
	remotePath = path.Join(remoteParent, path.Base(remotePath))

	dst, err := client.OpenFile(remotePath, os.O_WRONLY|os.O_CREATE|os.O_EXCL)
	if err != nil {
		return fmt.Errorf("create remote file %s error: %w", remotePath, err)
	}

	var src io.Reader = file
	if progress != nil {
		src = &progressReader{
			src:      file,
			total:    info.Size(),
			interval: 100 * time.Millisecond,
			report:   progress,
		}
	}
	_, copyErr := dst.ReadFromWithConcurrency(src, sftpConcurrency)
	if copyErr == nil && expected != nil {
		finalInfo, err := file.Stat()
		if err != nil {
			copyErr = fmt.Errorf("inspect local file after upload: %w", err)
		} else if finalInfo.Size() != expected.Size || finalInfo.ModTime().UnixNano() != expected.ModTime {
			copyErr = fmt.Errorf("local file changed during upload: %s", localPath)
		}
	}
	closeErr := dst.Close()

	if copyErr != nil {
		_ = client.Remove(remotePath) // 清理半截文件
		return fmt.Errorf("write file %s error: %w", remotePath, copyErr)
	}
	if closeErr != nil {
		_ = client.Remove(remotePath)
		return fmt.Errorf("close remote file %s error: %w", remotePath, closeErr)
	}

	return nil
}

func uploadOne(client *sftp.Client, realPath string, file UploadFile) error {
	src, err := file.Header.Open()
	if err != nil {
		return fmt.Errorf("open source file %s error: %w", file.Header.Filename, err)
	}
	defer src.Close()

	relative, err := cleanRelativePath(file)
	if err != nil {
		return err
	}

	dstPath := path.Join(realPath, relative)

	// create nested directories for folder uploads
	parent, err := ensureRemoteDirectory(client, realPath, path.Dir(dstPath))
	if err != nil {
		return fmt.Errorf("create remote dir: %w", err)
	}
	dstPath = path.Join(parent, path.Base(dstPath))

	dst, err := client.OpenFile(dstPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL)
	if err != nil {
		return fmt.Errorf("create remote file %s error: %w", dstPath, err)
	}

	_, copyErr := io.Copy(dst, src)
	closeErr := dst.Close()

	if copyErr != nil {
		_ = client.Remove(dstPath) // 清理半截文件
		return fmt.Errorf("write file %s error: %w", dstPath, copyErr)
	}
	if closeErr != nil {
		_ = client.Remove(dstPath)
		return fmt.Errorf("close remote file %s error: %w", dstPath, closeErr)
	}
	return nil
}

func cleanRelativePath(file UploadFile) (string, error) {
	relative := file.Relative
	if relative == "" {
		relative = file.Header.Filename
	}
	relative = strings.ReplaceAll(relative, "\\", "/")
	if relative == "" || path.IsAbs(relative) {
		return "", fmt.Errorf("invalid relative path: %s", relative)
	}
	for _, part := range strings.Split(relative, "/") {
		if part == "" || part == "." || part == ".." || strings.ContainsRune(part, 0) {
			return "", fmt.Errorf("invalid relative path: %s", relative)
		}
	}
	return relative, nil
}

// ensureRemoteDirectory resolves the trusted base and rejects links below it.
// SFTP does not provide an atomic openat-style operation, so a server-side
// actor can still race these checks; this is not a security boundary.
func ensureRemoteDirectory(client *sftp.Client, base, target string) (string, error) {
	if !path.IsAbs(base) || !path.IsAbs(target) {
		return "", fmt.Errorf("remote paths must be absolute")
	}
	base, target = path.Clean(base), path.Clean(target)
	rel := ""
	if target != base {
		prefix := strings.TrimSuffix(base, "/") + "/"
		if !strings.HasPrefix(target, prefix) {
			return "", fmt.Errorf("remote path outside target directory: %s", target)
		}
		rel = strings.TrimPrefix(target, prefix)
	}
	root, err := client.RealPath(base)
	if err != nil {
		return "", fmt.Errorf("resolve remote base: %w", err)
	}
	rootInfo, err := client.Stat(root)
	if err != nil {
		return "", err
	}
	if !rootInfo.IsDir() {
		return "", fmt.Errorf("remote base is not a directory: %s", base)
	}
	current := root
	if rel == "" {
		return current, nil
	}
	for _, part := range strings.Split(rel, "/") {
		current = path.Join(current, part)
		info, err := client.Lstat(current)
		if errors.Is(err, os.ErrNotExist) {
			if mkdirErr := client.Mkdir(current); mkdirErr != nil {
				// Another worker may have created this directory first.
				info, err = client.Lstat(current)
				if err != nil {
					return "", fmt.Errorf("create remote directory %s: %w", current, mkdirErr)
				}
			} else {
				info, err = client.Lstat(current)
			}
		}
		if err != nil {
			return "", fmt.Errorf("inspect remote directory %s: %w", current, err)
		}
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return "", fmt.Errorf("remote path is not a real directory: %s", current)
		}
	}
	return current, nil
}

// MkdirAll creates remote directories, including empty folders.
func (s *FileSvr) MkdirAll(client *sftp.Client, base string, dirPaths []string) error {
	for _, dirPath := range dirPaths {
		if !path.IsAbs(dirPath) {
			return fmt.Errorf("%s is not an absolute path", dirPath)
		}
	}

	for _, dirPath := range dirPaths {
		if _, err := ensureRemoteDirectory(client, base, dirPath); err != nil {
			return fmt.Errorf("create remote dir %s error: %w", dirPath, err)
		}
	}
	return nil
}

func (s *FileSvr) Download(client *sftp.Client, remotePath, localDir string) error {
	if !path.IsAbs(remotePath) {
		return fmt.Errorf("%s is not an absolute path", remotePath)
	}

	realPath, err := client.RealPath(remotePath)
	if err != nil {
		return fmt.Errorf("resolve remote path error: %w", err)
	}

	stat, err := client.Stat(realPath)
	if err != nil {
		return fmt.Errorf("stat file %s error: %w", realPath, err)
	}

	localPath := filepath.Join(localDir, path.Base(realPath))

	if stat.IsDir() {
		// folder downloads keep the remote directory tree under localDir
		if err := os.MkdirAll(localPath, 0755); err != nil {
			return fmt.Errorf("create local dir %s error: %w", localPath, err)
		}
		return downloadDir(client, realPath, localPath)
	}

	if err := os.MkdirAll(localDir, 0755); err != nil {
		return fmt.Errorf("create local dir %s error: %w", localDir, err)
	}
	return downloadFile(client, realPath, localPath)
}

func downloadDir(client *sftp.Client, remoteDir, localDir string) error {
	if err := os.MkdirAll(localDir, 0755); err != nil {
		return fmt.Errorf("create local dir %s error: %w", localDir, err)
	}

	files, err := client.ReadDir(remoteDir)
	if err != nil {
		return fmt.Errorf("read remote dir %s error: %w", remoteDir, err)
	}

	for _, file := range files {
		remote := path.Join(remoteDir, file.Name())
		local := filepath.Join(localDir, file.Name())

		if file.IsDir() {
			if err := downloadDir(client, remote, local); err != nil {
				return err
			}
			continue
		}

		if err := downloadFile(client, remote, local); err != nil {
			return err
		}
	}
	return nil
}

func downloadFile(client *sftp.Client, remotePath, localPath string) error {
	src, err := client.Open(remotePath) // 只读打开远程文件
	if err != nil {
		return fmt.Errorf("open remote file %s error: %w", remotePath, err)
	}
	defer src.Close()

	dst, err := os.OpenFile(localPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
	if err != nil {
		return fmt.Errorf("create local file %s error: %w", localPath, err)
	}

	_, copyErr := io.Copy(dst, src) // 远程 reader -> 本地 writer
	closeErr := dst.Close()

	if copyErr != nil {
		_ = os.Remove(localPath) // 清理半截文件
		return fmt.Errorf("write local file %s error: %w", localPath, copyErr)
	}
	if closeErr != nil {
		_ = os.Remove(localPath)
		return fmt.Errorf("close local file %s error: %w", localPath, closeErr)
	}
	return nil
}

// openUploadSource verifies the scanned file before using its open handle.
func openUploadSource(localPath string, expected *SourceSnapshot) (*os.File, os.FileInfo, error) {
	before, err := os.Lstat(localPath)
	if err != nil {
		return nil, nil, fmt.Errorf("inspect local file: %w", err)
	}
	if !before.Mode().IsRegular() {
		return nil, nil, fmt.Errorf("not a regular file: %s", localPath)
	}
	file, err := os.Open(localPath)
	if err != nil {
		return nil, nil, fmt.Errorf("open file: %w", err)
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, nil, fmt.Errorf("stat local file: %w", err)
	}
	if !info.Mode().IsRegular() || !os.SameFile(before, info) {
		_ = file.Close()
		return nil, nil, fmt.Errorf("local file changed while opening: %s", localPath)
	}
	if expected != nil && (info.Size() != expected.Size || info.ModTime().UnixNano() != expected.ModTime) {
		_ = file.Close()
		return nil, nil, fmt.Errorf("local file changed since scan: %s", localPath)
	}
	return file, info, nil
}
