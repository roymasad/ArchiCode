package svc

import "example.com/demo/internal/store"

func Run() string { return store.Get() }
