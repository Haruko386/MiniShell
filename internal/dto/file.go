package dto

type GetFileRequest struct {
	Version string  `json:"version"`
	Content *string `json:"content"`
}

type CreateEntryRequest struct {
	Path string `json:"path" binding:"required"`
	Name string `json:"name" binding:"required"`
}
