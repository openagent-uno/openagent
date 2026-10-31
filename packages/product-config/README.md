# openagent-product-config

Product-owned product-config implementation. Consumes the independently versioned Core package; Core must never import this package.

The standalone catalog explicitly uses the Core41 instance-owned management
adapters for models, budgets and skill data. Each source keeps its runtime
and absolute database binding; independent module defaults remain unchanged.
This avoids cold subprocess imports during startup and closes management
connections with their owning module.
