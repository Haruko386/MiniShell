package service

import (
	"fmt"
	"io"
	"mime/multipart"
	"os"
	"path"
	"path/filepath"

	"github.com/Haruko386/MiniShell/internal/entity"
	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

type FileSvr struct{}

func NewFileSvr() *FileSvr {
	return &FileSvr{}
}

func (s *FileSvr) List(sshClient *ssh.Client, dirPath string) (string, []entity.FileEntry, error) {
	if !path.IsAbs(dirPath) {
		return "", nil, fmt.Errorf("%s is not an absolute path", dirPath)
	}

	// create a SFTP tunnel based on ssh client
	client, err := sftp.NewClient(sshClient)
	if err != nil {
		return "", nil, fmt.Errorf("create SFTP client error: %w", err)
	}
	defer client.Close()

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

func (s *FileSvr) Upload(sshClient *ssh.Client, dirPath string, files []*multipart.FileHeader) error {
	if !path.IsAbs(dirPath) {
		return fmt.Errorf("%s is not an absolute path", dirPath)
	}

	client, err := sftp.NewClient(sshClient)
	if err != nil {
		return fmt.Errorf("create SFTP client error: %w", err)
	}
	defer client.Close()

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
func (s *FileSvr) UploadLocal(sshClient *ssh.Client, localPath, remotePath string) error {
	return s.UploadLocalWithProgress(sshClient, localPath, remotePath, nil)
}

// UploadLocalWithProgress reports bytes acknowledged by the SFTP writer.
func (s *FileSvr) UploadLocalWithProgress(sshClient *ssh.Client, localPath, remotePath string, progress func(int64, int64)) error {
	if !path.IsAbs(remotePath) {
		return fmt.Errorf("%s is not an absolute path", remotePath)
	}

	client, err := sftp.NewClient(sshClient)
	if err != nil {
		return fmt.Errorf("create SFTP client error: %w", err)
	}
	defer client.Close()

	file, err := os.Open(localPath)
	if err != nil {
		return fmt.Errorf("open file error: %w", err)
	}
	defer file.Close()

	info, err := file.Stat()
	if err != nil {
		return fmt.Errorf("stat local file: %w", err)
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("not a regular file: %s", localPath)
	}
	if progress != nil {
		progress(0, info.Size())
	}

	dst, err := client.OpenFile(remotePath, os.O_WRONLY|os.O_CREATE|os.O_EXCL)
	if err != nil {
		return fmt.Errorf("create remote file %s error: %w", remotePath, err)
	}

	var writer io.Writer = dst
	if progress != nil {
		writer = &progressWriter{dst: dst, total: info.Size(), report: progress}
	}
	_, copyErr := io.Copy(writer, file)
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

func uploadOne(client *sftp.Client, realPath string, file *multipart.FileHeader) error {
	src, err := file.Open()
	if err != nil {
		return fmt.Errorf("open source file %s error: %w", file.Filename, err)
	}
	defer src.Close()

	dstPath := path.Join(realPath, filepath.Base(file.Filename))

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

func (s *FileSvr) Download(sshClient *ssh.Client, remotePath, localDir string) error {
	if !path.IsAbs(remotePath) {
		return fmt.Errorf("%s is not an absolute path", remotePath)
	}

	client, err := sftp.NewClient(sshClient)
	if err != nil {
		return fmt.Errorf("create SFTP client error: %w", err)
	}
	defer client.Close()

	realPath, err := client.RealPath(remotePath)
	if err != nil {
		return fmt.Errorf("resolve remote path error: %w", err)
	}

	stat, err := client.Stat(realPath)
	if err != nil {
		return fmt.Errorf("stat file %s error: %w", realPath, err)
	}
	if stat.IsDir() {
		return fmt.Errorf("%s is a directory, not supported yet", realPath)
	}

	src, err := client.Open(realPath) // 只读打开远程文件
	if err != nil {
		return fmt.Errorf("open remote file %s error: %w", realPath, err)
	}
	defer src.Close()

	if err := os.MkdirAll(localDir, 0755); err != nil {
		return fmt.Errorf("create local dir %s error: %w", localDir, err)
	}

	localPath := filepath.Join(localDir, path.Base(realPath)) // using filepath for local path
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

// progressWriter counts only bytes successfully written, including partial writes.
type progressWriter struct {
	dst     io.Writer
	total   int64
	written int64
	report  func(int64, int64)
}

func (w *progressWriter) Write(p []byte) (int, error) {
	n, err := w.dst.Write(p)
	if n > 0 {
		w.written += int64(n)
		w.report(w.written, w.total)
	}
	return n, err
}
