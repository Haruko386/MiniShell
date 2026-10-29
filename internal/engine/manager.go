package engine

import (
	"context"
	"errors"
	"fmt"
	"path"
	"sync"

	"github.com/Haruko386/MiniShell/internal/common"
	"github.com/Haruko386/MiniShell/internal/entity"
	"github.com/Haruko386/MiniShell/internal/service"
)

type Manager struct {
	ID       string
	jobs     chan entity.Task
	results  chan entity.Task
	mu       sync.Mutex
	submitMu sync.RWMutex
	wg       sync.WaitGroup
	tasks    map[string]entity.TaskStatus

	SessionSvr *service.SessionSvr
	FileSvr    *service.FileSvr

	collectorDone chan struct{}

	lifeCycleMu   sync.Mutex
	managerStatus entity.ManagerStatus
	stopping      chan struct{}
	stopOnce      sync.Once
}

func NewManager(sessionSvr *service.SessionSvr, fileSvr *service.FileSvr) *Manager {
	return &Manager{
		mu:            sync.Mutex{},
		submitMu:      sync.RWMutex{},
		jobs:          make(chan entity.Task, 600),
		results:       make(chan entity.Task, 400),
		SessionSvr:    sessionSvr,
		FileSvr:       fileSvr,
		tasks:         make(map[string]entity.TaskStatus),
		collectorDone: make(chan struct{}),
		managerStatus: entity.ManagerStatusCreated,
		stopping:      make(chan struct{}),
	}
}

// Start the manager life cycle and worker
func (m *Manager) Start(workerNum int) error {
	if workerNum <= 0 {
		return errors.New("worker count must be greater than zero")
	}

	// Hold the lifecycle lock until all workers are registered. Stop cannot
	// call Wait while Start is still calling Add.
	m.lifeCycleMu.Lock()
	defer m.lifeCycleMu.Unlock()
	if m.managerStatus != entity.ManagerStatusCreated {
		return fmt.Errorf("manager cannot start, status=%s", m.managerStatus)
	}

	m.wg.Add(workerNum)
	for i := 0; i < workerNum; i++ {
		go m.worker(i)
	}
	go func() {
		defer close(m.collectorDone)
		for task := range m.results {
			m.updateStatus(task.ID, task.Status, task.Error)
		}
	}()
	m.managerStatus = entity.ManagerStatusRunning
	return nil
}

func (m *Manager) Submit(ctx context.Context, task entity.Task) (string, error) {
	if task.SessionID == "" {
		return "", errors.New("session id is required")
	}

	if task.Direction != "upload" && task.Direction != "download" {
		return "", fmt.Errorf("unsupported direction: %s", task.Direction)
	}

	if task.LocalPath == "" || task.RemotePath == "" {
		return "", fmt.Errorf("local path and remote path are required")
	}

	if err := ctx.Err(); err != nil {
		return "", err
	}

	m.submitMu.RLock()
	defer m.submitMu.RUnlock()

	if !m.canAcceptTask() {
		return "", errors.New("manager is not running")
	}

	taskID := common.GenerateUUID()
	task.ID = taskID
	task.Status = entity.TaskCreated

	// write the status
	m.mu.Lock()
	m.tasks[taskID] = entity.TaskStatus{
		Status:    task.Status,
		Error:     task.Error,
		SessionID: task.SessionID,
	}
	m.mu.Unlock()

	select {
	case <-ctx.Done():
		m.mu.Lock()
		delete(m.tasks, taskID)
		m.mu.Unlock()
		return "", ctx.Err()
	case <-m.stopping:
		m.mu.Lock()
		delete(m.tasks, taskID)
		m.mu.Unlock()
		return "", errors.New("manager is draining")
	case m.jobs <- task:
		return taskID, nil
	}
}

func (m *Manager) worker(id int) {
	defer m.wg.Done()

	for task := range m.jobs {
		task.Status = entity.TaskInProgress

		m.updateStatus(task.ID, task.Status, nil)

		err := m.work(task)

		if err != nil {
			task.Status = entity.TaskFailed
			task.Error = err
		} else {
			task.Status = entity.TaskSuccess
		}

		// send the result
		m.results <- task
	}
}

func (m *Manager) work(task entity.Task) error {
	sftpClient, err := m.SessionSvr.GetSFTP(task.SessionID)
	if err != nil {
		return fmt.Errorf("session %s: %w", task.SessionID, err)
	}

	switch task.Direction {
	case "upload":
		base := task.RemoteBase
		if base == "" {
			base = path.Dir(task.RemotePath)
		}
		var snapshot *service.SourceSnapshot
		if task.VerifySource {
			snapshot = &service.SourceSnapshot{Size: task.SourceSize, ModTime: task.SourceModTime}
		}
		return m.FileSvr.UploadLocalChecked(sftpClient, task.LocalPath, task.RemotePath, base, snapshot, func(done, total int64) { m.updateProgress(task.ID, done, total) })
	case "download":
		return m.FileSvr.Download(sftpClient, task.RemotePath, task.LocalPath)
	default:
		return fmt.Errorf("unsupported direction: %s", task.Direction)
	}
}

func (m *Manager) Stop() {
	m.stopOnce.Do(func() {
		m.lifeCycleMu.Lock()
		switch m.managerStatus {
		case entity.ManagerStatusCreated:
			m.managerStatus = entity.ManagerStatusStopped
			m.lifeCycleMu.Unlock()
			close(m.stopping)
			return
		case entity.ManagerStatusRunning:
			m.managerStatus = entity.ManagerStatusDraining
		case entity.ManagerStatusStopped, entity.ManagerStatusDraining:
			m.lifeCycleMu.Unlock()
			return
		}
		m.lifeCycleMu.Unlock()

		close(m.stopping)

		m.submitMu.Lock()
		close(m.jobs)
		m.submitMu.Unlock()

		m.wg.Wait()

		close(m.results)
		<-m.collectorDone

		m.lifeCycleMu.Lock()
		m.managerStatus = entity.ManagerStatusStopped
		m.lifeCycleMu.Unlock()
	})
}

func (m *Manager) GetStatus(taskID string) (entity.TaskStatus, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()

	status, ok := m.tasks[taskID]
	return status, ok
}

func (m *Manager) updateStatus(taskID, status string, taskErr error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	current, ok := m.tasks[taskID]
	if !ok {
		return
	}

	current.Status = status
	current.Error = taskErr
	m.tasks[taskID] = current
}

/* manager status */

func (m *Manager) Status() entity.ManagerStatus {
	m.lifeCycleMu.Lock()
	defer m.lifeCycleMu.Unlock()
	return m.managerStatus
}

func (m *Manager) canAcceptTask() bool {
	m.lifeCycleMu.Lock()
	defer m.lifeCycleMu.Unlock()
	return m.managerStatus == entity.ManagerStatusRunning
}

// updateProgress keeps the latest upload byte counters in the task snapshot.
func (m *Manager) updateProgress(taskID string, done, total int64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	current, ok := m.tasks[taskID]
	if !ok {
		return
	}
	current.TransferredBytes = done
	current.TotalBytes = total
	m.tasks[taskID] = current
}
