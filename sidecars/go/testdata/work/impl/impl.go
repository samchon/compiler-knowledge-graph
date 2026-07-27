package impl

import (
	"strings"

	"example.com/api"
)

type Base struct{}

// Two compile-time interface assertions, the ordinary Go idiom for them. Both
// declare the blank identifier at package scope, so both once derived
// `example.com/impl._` and the second one failed the whole build as a
// conflicting node — which is how gin, with the same two lines, brought the
// benchmark's go lane down to the static reader.
var _ api.Greeter = Base{}
var _ api.Transformer = Base{}

// Two package initializers, which Go permits and gin actually has. They share
// one FullName because nothing may refer to either, so before they were
// disambiguated by position the second one failed the build outright.
var initialized string

func init() {
	initialized = Resolve()
}

func init() {
	initialized += api.Resolve()
}

func (Base) Greet(name string) string {
	return "hello " + name
}

func (Base) Transform(value api.Input) api.Input {
	return value
}

type Service struct {
	Base
	Box   api.Box[string]
	Count int
}

func NewService() *Service {
	return &Service{Box: api.Box[string]{Value: "ready"}}
}

func Resolve() string {
	return "impl"
}

func ReadLeft(value api.Left) string {
	return value.Value
}

func Run() string {
	service := NewService()
	service.Count++
	greeter := service.Greet
	_ = greeter
	var builder strings.Builder
	length := builder.Len
	_ = length
	_ = Resolve()
	var dynamic any = func() string { return "dynamic" }
	_ = dynamic.(func() string)()
	return api.Invoke(service)
}
