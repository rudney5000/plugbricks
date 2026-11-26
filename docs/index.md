---
layout: home

hero:
  name: plugbricks
  text: A federated GraphQL platform from bricks
  tagline: Describe your APIs, your database and your queue; run them behind one router, on Docker Compose or Kubernetes.
  actions:
    - theme: brand
      text: Getting started
      link: /guide/getting-started
    - theme: alt
      text: Source on GitHub
      link: https://github.com/rudney5000/plugbricks

features:
  - title: A tool, not a framework
    details: Your code never imports plugbricks. A brick is a container image and a manifest; it reads the variables it was promised.
  - title: One contract per API
    details: Each API ships its GraphQL schema. Composition is checked when a brick is added, not when it fails in production.
  - title: Your services as they are
    details: New ones in TypeScript, Python or Go; existing GraphQL, gRPC and REST services too.
  - title: Not locked in
    details: Export plain Compose or Kubernetes files whenever you want to leave.
---
