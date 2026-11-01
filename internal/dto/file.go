package dto

type GetFileRequest struct {
	Version string  `json:"version"`
	Content *string `json:"content"`
}
