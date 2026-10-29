package entity

type ManagerStatus int

const (
	ManagerStatusCreated ManagerStatus = iota
	ManagerStatusRunning
	ManagerStatusDraining
	ManagerStatusStopped
)

func (m ManagerStatus) String() string {
	switch m {
	case ManagerStatusCreated:
		return "Created"
	case ManagerStatusRunning:
		return "Running"
	case ManagerStatusDraining:
		return "Draining"
	case ManagerStatusStopped:
		return "Stopped"
	}
	return "Unknown"
}
