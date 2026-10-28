package entity

import "time"

type FileEntry struct {
	Name       string    `bson:"name"`
	Type       string    `bson:"type"`
	Size       int64     `bson:"size"`
	ModifiedAt time.Time `bson:"modifiedAt"`
}
