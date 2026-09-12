// A renderer is a pure (value) => nodes function, and a node is a string or
// {tag, attrs?, children?}.
(value) => [{ tag: "p", children: [String(value ?? "")] }];
