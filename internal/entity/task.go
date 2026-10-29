package entity

const (
	TaskSuccess    = "success"
	TaskFailed     = "failed"
	TaskInProgress = "in_progress"
	TaskCreated    = "created"
)

// Task One Task means download one file(for now)
type Task struct {
	ID            string
	SessionID     string
	Status        string
	Direction     string
	LocalPath     string
	RemotePath    string
	Error         error
	RemoteBase    string
	VerifySource  bool
	SourceSize    int64
	SourceModTime int64
}

type TaskStatus struct {
	TransferredBytes int64
	TotalBytes       int64
	SessionID        string
	Status           string
	Error            error
}
