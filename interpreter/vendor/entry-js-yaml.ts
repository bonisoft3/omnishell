// Bundle entry: shell.yaml's parser (built by the `bundle:js-yaml` script; the
// output is the checked-in vendor/js-yaml.js static). Vendored because it sits
// in the boot chain before first paint — a CDN origin there costs a connection
// setup on every cold load and breaks self-containment.
export { load } from "npm:js-yaml@4.1.0";
