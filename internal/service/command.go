package service

import (
	"bytes"
	"context"
	"io"

	"golang.org/x/crypto/ssh"
)

type commandReadResult struct {
	output string
	err    error
}

func readRemoteCommand(ctx context.Context, client *ssh.Client, command string) (string, error) {
	done := make(chan commandReadResult, 1)

	go func() {
		if err := ctx.Err(); err != nil {
			done <- commandReadResult{err: err}
			return
		}

		channel, err := client.NewSession()
		if err != nil {
			done <- commandReadResult{err: err}
			return
		}
		defer channel.Close()

		var output bytes.Buffer
		channel.Stdout = &output
		channel.Stderr = io.Discard

		stop := context.AfterFunc(ctx, func() { _ = channel.Close() })
		defer stop()

		if err := ctx.Err(); err != nil {
			done <- commandReadResult{err: err}
			return
		}
		runErr := channel.Run(command)
		if err := ctx.Err(); err != nil {
			done <- commandReadResult{err: err}
			return
		}
		done <- commandReadResult{output: output.String(), err: runErr}
	}()

	select {
	case <-ctx.Done():
		return "", ctx.Err()
	case result := <-done:
		return result.output, result.err
	}
}
