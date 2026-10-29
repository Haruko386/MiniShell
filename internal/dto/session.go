package dto

type CreateSessionRequest struct {
	Host               string `json:"host"`
	Port               int    `json:"port"`
	Username           string `json:"username"`
	Password           string `json:"password"`
	HostKeyMode        string `json:"hostKeyMode"`
	HostKeyFingerprint string `json:"hostKeyFingerprint"`
}
