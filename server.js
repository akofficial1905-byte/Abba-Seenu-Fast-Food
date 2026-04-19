// server.js – Abba SEENUUU... FAST FOODS (NO Razorpay)

const express = require("express");
const http = require("http");
const socketio = require("socket.io");
const cors = require("cors");
const path = require("path");
const mongoose = require("mongoose");
const fs = require("fs");

require("dotenv").config();

const app = express();
const server = http.createServer(app);
const io = socketio(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "PATCH", "DELETE"]
  }
});

const PORT = process.env.PORT || 4000;

// --- Manager Portal Login ---
const managerUser = process.env.MANAGER_USER || "admin";
const managerPass = process.env.MANAGER_PASS || "abbaseenu2025";

// --- MongoDB connection ---
const MONGO_URI =
  process.env.MONGO_URI ||
  "mongodb+srv://architkumarsncp2123_db_user:abbaseenu@abbaseenudb.5sndjat.mongodb.net/?appName=AbbaSeenudb";

mongoose.connect(MONGO_URI, {
  dbName: "AbbaSeenudb"
});

mongoose.connection.on("connected", () => {
  console.log("✅ Connected to MongoDB (Abba SEENUUU... FAST FOODS)");
});

mongoose.connection.on("error", (err) => {
  console.error("❌ MongoDB Error:", err);
});

// --- Schemas ---
const orderSchema = new mongoose.Schema({
  orderType: String,
  customerName: String,
  registrationNumber: String,
  mobile: String,
  tableNumber: String,
  address: String,
  location: {
    lat: Number,
    lng: Number
  },
  paymentMethod: String,
  paymentVerified: {
    type: Boolean,
    default: false
  },
  specialRequest: String,
  requestTags: [String],
  items: [
    {
      name: String,
      variant: String,
      price: Number,
      qty: Number
    }
  ],
  total: Number,
  status: {
    type: String,
    default: "incoming"
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  }
});

// Auto-delete orders after 90 days
orderSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7776000 });

const Order = mongoose.model("Order", orderSchema);

const serviceRequestSchema = new mongoose.Schema({
  type: String,
  requestType: String,
  customerName: String,
  mobile: String,
  registrationNumber: String,
  orderType: String,
  tableNumber: String,
  address: String,
  location: {
    lat: Number,
    lng: Number
  },
  status: {
    type: String,
    default: "pending"
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  }
});

// Auto-delete service requests after 7 days
serviceRequestSchema.index({ createdAt: 1 }, { expireAfterSeconds: 604800 });

const ServiceRequest = mongoose.model("ServiceRequest", serviceRequestSchema);

const tableDraftSchema = new mongoose.Schema({
  tableNumber: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  customerName: {
    type: String,
    default: ""
  },
  mobile: {
    type: String,
    default: ""
  },
  guestCount: {
    type: Number,
    default: 1
  },
  status: {
    type: String,
    default: "available"
  },
  items: [
    {
      name: String,
      variant: String,
      price: Number,
      qty: Number,
      category: String
    }
  ],
  total: {
    type: Number,
    default: 0
  },
  lastPrintedAt: Date,
  updatedAt: {
    type: Date,
    default: Date.now
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

tableDraftSchema.pre("save", function (next) {
  this.updatedAt = new Date();
  this.total = (this.items || []).reduce(
    (sum, item) => sum + (Number(item.price || 0) * Number(item.qty || 0)),
    0
  );
  next();
});

const TableDraft = mongoose.model("TableDraft", tableDraftSchema);

// --- AUTO PRINT QUEUE ---
let printQueue = [];

// --- Express middleware ---
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

// --- Helpers ---
function normalizeRequestType(value) {
  const v = String(value || "").trim().toLowerCase();
  if (v === "manager" || v === "call manager") return "manager";
  if (v === "waiter" || v === "call waiter") return "waiter";
  return v || "waiter";
}

function getISTDateBounds(dateStr) {
  const date = dateStr || new Date().toISOString().slice(0, 10);
  const start = new Date(Date.parse(date + "T00:00:00+05:30"));
  const end = new Date(Date.parse(date + "T23:59:59+05:30"));
  return { start, end };
}

function calcTotal(items = []) {
  return items.reduce(
    (sum, item) => sum + (Number(item.price || 0) * Number(item.qty || 0)),
    0
  );
}

async function saveAndBroadcastOrder(orderData) {
  const order = new Order(orderData);
  await order.save();
  io.emit("newOrder", order);
  printQueue.push(order);
  return order;
}

function sanitizeTableDraftPayload(body = {}) {
  const items = Array.isArray(body.items)
    ? body.items.map((item) => ({
        name: item?.name || "",
        variant: item?.variant || "",
        price: Number(item?.price || 0),
        qty: Number(item?.qty || 0),
        category: item?.category || ""
      }))
      .filter((x) => x.name && x.qty > 0)
    : [];

  const status =
    body.status === "billed"
      ? "billed"
      : items.length
      ? "draft"
      : "available";

  return {
    tableNumber: String(body.tableNumber || "").trim(),
    customerName: String(body.customerName || "").trim(),
    mobile: String(body.mobile || "").trim(),
    guestCount: Math.max(1, Number(body.guestCount || 1)),
    status,
    items,
    total: calcTotal(items)
  };
}

// --- Manager Login API ---
app.post("/api/manager/login", (req, res) => {
  const { username, password } = req.body || {};

  console.log("🔐 Manager login attempt:", {
    username,
    hasPassword: !!password
  });

  if (!username || !password) {
    return res.status(400).json({
      success: false,
      message: "Missing credentials"
    });
  }

  if (username === managerUser && password === managerPass) {
    console.log("✅ Manager login success");
    return res.json({ success: true });
  }

  console.log("❌ Manager login failed");
  return res.status(401).json({
    success: false,
    message: "Invalid credentials"
  });
});

// --- Change Manager ID / Password ---
app.post("/api/manager/change-credentials", (req, res) => {
  return res.status(400).json({
    success: false,
    message:
      "Change login is disabled. Update MANAGER_USER and MANAGER_PASS in server config or .env file."
  });
});

// --- Serve menu file ---
app.get("/menu.json", (req, res) => {
  res.sendFile(path.join(__dirname, "public/menu.json"));
});

// --- Inventory: update menu.json ---
app.post("/update-menu", (req, res) => {
  try {
    const filePath = path.join(__dirname, "public", "menu.json");
    const data = JSON.stringify(req.body, null, 2);

    fs.writeFile(filePath, data, "utf8", (err) => {
      if (err) {
        console.error("Error writing menu.json:", err);
        return res.status(500).json({ error: "Failed to save menu" });
      }
      res.json({ success: true });
    });
  } catch (e) {
    console.error("Error in /update-menu:", e);
    res.status(500).json({ error: "Server error" });
  }
});

// ---------------- ORDERS APIs ----------------

// Get orders for a given date (IST) and optional status
app.get("/api/orders", async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const { start, end } = getISTDateBounds(date);
    const { status } = req.query;

    const query = {
      createdAt: { $gte: start, $lte: end },
      status: { $ne: "deleted" }
    };

    if (status) query.status = status;

    const orders = await Order.find(query).sort({ createdAt: -1 });
    res.json(orders);
  } catch (err) {
    console.error("Get orders error:", err);
    res.status(500).json({ error: "Could not fetch orders" });
  }
});

// Place new order
app.post("/api/orders", async (req, res) => {
  try {
    const {
      orderType,
      customerName,
      registrationNumber,
      mobile,
      tableNumber,
      address,
      location,
      items,
      paymentMethod,
      specialRequest,
      requestTags
    } = req.body || {};

    const normalizedItems = Array.isArray(items)
      ? items.map((item) => ({
          name: item?.name || "",
          variant: item?.variant || "",
          price: Number(item?.price || 0),
          qty: Number(item?.qty || 0)
        }))
      : [];

    const total = calcTotal(normalizedItems);

    const order = await saveAndBroadcastOrder({
      orderType: orderType || "",
      customerName: customerName || "",
      registrationNumber: registrationNumber || "",
      mobile: mobile || "",
      tableNumber: tableNumber || "",
      address: address || "",
      location: location || null,
      items: normalizedItems,
      total,
      paymentMethod: paymentMethod || "COD",
      paymentVerified: false,
      specialRequest: specialRequest || "",
      requestTags: Array.isArray(requestTags) ? requestTags : [],
      status: "incoming"
    });

    res.json({ success: true, order });
  } catch (err) {
    console.error("Create order error:", err);
    res.status(500).json({
      success: false,
      error: "Could not create order"
    });
  }
});

// Update order status
app.patch("/api/orders/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body || {};

    const order = await Order.findByIdAndUpdate(
      id,
      { status },
      { new: true }
    );

    if (!order) {
      return res.status(404).json({
        success: false,
        error: "Order not found"
      });
    }

    io.emit("orderUpdated", order);
    res.json({ success: true, order });
  } catch (err) {
    console.error("Update status error:", err);
    res.status(500).json({
      success: false,
      error: "Could not update status"
    });
  }
});

// Toggle payment verification
app.patch("/api/orders/:id/payment-verified", async (req, res) => {
  try {
    const { id } = req.params;
    const { paymentVerified } = req.body || {};

    const order = await Order.findByIdAndUpdate(
      id,
      { paymentVerified: !!paymentVerified },
      { new: true }
    );

    if (!order) {
      return res.status(404).json({
        success: false,
        error: "Order not found"
      });
    }

    io.emit("orderUpdated", order);
    res.json({ success: true, order });
  } catch (err) {
    console.error("Payment verify update error:", err);
    res.status(500).json({
      success: false,
      error: "Could not update payment verification"
    });
  }
});

// Hard delete
app.delete("/api/orders/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await Order.findByIdAndDelete(id);
    res.json({ success: true });
  } catch (err) {
    console.error("Delete order error:", err);
    res.status(500).json({
      success: false,
      error: "Could not delete order"
    });
  }
});

// ---------------- SERVICE REQUEST APIs ----------------

// Create a service request
app.post("/api/service-request", async (req, res) => {
  try {
    const {
      type,
      requestType,
      customerName,
      mobile,
      registrationNumber,
      orderType,
      tableNumber,
      address,
      location
    } = req.body || {};

    const normalizedRequestType = normalizeRequestType(requestType || type);

    const sr = new ServiceRequest({
      type: normalizedRequestType,
      requestType: normalizedRequestType,
      customerName: customerName || "",
      mobile: mobile || "",
      registrationNumber: registrationNumber || "",
      orderType: orderType || "",
      tableNumber: tableNumber || "",
      address: address || "",
      location: location || null,
      status: "pending"
    });

    await sr.save();

    const payload = sr.toObject();
    payload.requestType = normalizedRequestType;
    payload.type = normalizedRequestType;

    io.emit("serviceRequest", payload);

    res.json({ success: true, serviceRequest: payload });
  } catch (err) {
    console.error("Create service request error:", err);
    res.status(500).json({
      success: false,
      error: "Could not create service request"
    });
  }
});

// Optional: fetch recent service requests for manager dashboard
app.get("/api/service-request", async (req, res) => {
  try {
    const { start, end } = getISTDateBounds(
      req.query.date || new Date().toISOString().slice(0, 10)
    );

    const list = await ServiceRequest.find({
      createdAt: { $gte: start, $lte: end }
    }).sort({ createdAt: -1 });

    const normalized = list.map((item) => {
      const obj = item.toObject();
      const rt = normalizeRequestType(obj.requestType || obj.type);
      return {
        ...obj,
        requestType: rt,
        type: rt
      };
    });

    res.json(normalized);
  } catch (err) {
    console.error("Get service requests error:", err);
    res.status(500).json({ error: "Could not get service requests" });
  }
});

// ---------------- TABLE DRAFT APIs ----------------

// Get all table drafts for manager POS
app.get("/api/table-orders", async (req, res) => {
  try {
    const drafts = await TableDraft.find({}).sort({ tableNumber: 1 });
    res.json(drafts);
  } catch (err) {
    console.error("Get table drafts error:", err);
    res.status(500).json({ success: false, error: "Could not get table drafts" });
  }
});

// Save / update one table draft
app.post("/api/table-orders/save-draft", async (req, res) => {
  try {
    const payload = sanitizeTableDraftPayload(req.body);

    if (!payload.tableNumber) {
      return res.status(400).json({
        success: false,
        error: "tableNumber is required"
      });
    }

    const draft = await TableDraft.findOneAndUpdate(
      { tableNumber: payload.tableNumber },
      {
        ...payload,
        updatedAt: new Date()
      },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true
      }
    );

    io.emit("tableDraftUpdated", draft);
    res.json({ success: true, draft });
  } catch (err) {
    console.error("Save table draft error:", err);
    res.status(500).json({ success: false, error: "Could not save table draft" });
  }
});

// Clear one table draft
app.post("/api/table-orders/clear", async (req, res) => {
  try {
    const tableNumber = String(req.body?.tableNumber || "").trim();

    if (!tableNumber) {
      return res.status(400).json({
        success: false,
        error: "tableNumber is required"
      });
    }

    await TableDraft.findOneAndDelete({ tableNumber });

    io.emit("tableDraftCleared", { tableNumber });
    res.json({ success: true, tableNumber });
  } catch (err) {
    console.error("Clear table draft error:", err);
    res.status(500).json({ success: false, error: "Could not clear table draft" });
  }
});

// Print/finalize one table draft as a real order
app.post("/api/table-orders/print", async (req, res) => {
  try {
    const payload = sanitizeTableDraftPayload(req.body);

    if (!payload.tableNumber) {
      return res.status(400).json({
        success: false,
        error: "tableNumber is required"
      });
    }

    if (!payload.items.length) {
      return res.status(400).json({
        success: false,
        error: "No items in table draft"
      });
    }

    const order = await saveAndBroadcastOrder({
      orderType: "dinein",
      customerName: payload.customerName || "",
      registrationNumber: "",
      mobile: payload.mobile || "",
      tableNumber: payload.tableNumber,
      address: "",
      location: null,
      items: payload.items.map((i) => ({
        name: i.name,
        variant: i.variant || "",
        price: Number(i.price || 0),
        qty: Number(i.qty || 0)
      })),
      total: payload.total || calcTotal(payload.items),
      paymentMethod: "COD",
      paymentVerified: false,
      specialRequest: "",
      requestTags: [],
      status: "incoming"
    });

    const draft = await TableDraft.findOneAndUpdate(
      { tableNumber: payload.tableNumber },
      {
        ...payload,
        status: "billed",
        total: payload.total || calcTotal(payload.items),
        lastPrintedAt: new Date(),
        updatedAt: new Date()
      },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true
      }
    );

    io.emit("tableDraftUpdated", draft);

    res.json({
      success: true,
      order,
      draft
    });
  } catch (err) {
    console.error("Print/finalize table draft error:", err);
    res.status(500).json({
      success: false,
      error: "Could not print/finalize table draft"
    });
  }
});

// ---------------- DASHBOARD APIs ----------------

// Total sales for a day/week/month (IST)
app.get("/api/dashboard/sales", async (req, res) => {
  try {
    const period = req.query.period || "day";
    const date = req.query.date || new Date().toISOString().slice(0, 10);

    let start, end;

    if (period === "day") {
      ({ start, end } = getISTDateBounds(date));
    } else if (period === "week") {
      const { start: dayStart } = getISTDateBounds(date);
      const d = new Date(dayStart);
      const first = new Date(d.setDate(d.getDate() - d.getDay()));
      start = new Date(first.setHours(0, 0, 0, 0));
      end = new Date(new Date(start).setDate(start.getDate() + 7));
    } else if (period === "month") {
      const { start: dayStart } = getISTDateBounds(date);
      const d = new Date(dayStart);
      start = new Date(d.getFullYear(), d.getMonth(), 1);
      end = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
    } else {
      ({ start, end } = getISTDateBounds(date));
    }

    const orders = await Order.find({
      createdAt: { $gte: start, $lte: end },
      status: { $ne: "deleted" }
    });

    const total = orders.reduce((sum, o) => sum + (o.total || 0), 0);
    res.json({ total, count: orders.length });
  } catch (err) {
    console.error("Dashboard sales error:", err);
    res.status(500).json({ error: "Could not get sales" });
  }
});

// Peak hour (IST)
app.get("/api/dashboard/peakhour", async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const { start, end } = getISTDateBounds(date);

    const orders = await Order.find({
      createdAt: { $gte: start, $lte: end },
      status: { $ne: "deleted" }
    });

    const hourly = {};
    orders.forEach((o) => {
      const hour = new Date(o.createdAt).getHours();
      hourly[hour] = (hourly[hour] || 0) + 1;
    });

    let peak = { hour: "-", count: 0 };
    Object.entries(hourly).forEach(([h, c]) => {
      if (c > peak.count) peak = { hour: h, count: c };
    });

    res.json(peak);
  } catch (err) {
    console.error("Peakhour error:", err);
    res.status(500).json({ error: "Could not get peak hour" });
  }
});

// Most ordered dish (IST)
app.get("/api/dashboard/topdish", async (req, res) => {
  try {
    let start, end;

    if (req.query.from && req.query.to) {
      ({ start, end } = getISTDateBounds(req.query.from));
      const toBounds = getISTDateBounds(req.query.to);
      end = toBounds.end;
    } else {
      const date = req.query.date || new Date().toISOString().slice(0, 10);
      ({ start, end } = getISTDateBounds(date));
    }

    const orders = await Order.find({
      createdAt: { $gte: start, $lte: end },
      status: { $ne: "deleted" }
    });

    const countMap = {};
    orders.forEach((o) => {
      (o.items || []).forEach((i) => {
        const n = i.name || "Unnamed Item";
        countMap[n] = (countMap[n] || 0) + (i.qty || 0);
      });
    });

    const top = Object.entries(countMap).sort((a, b) => b[1] - a[1])[0];
    res.json(top ? { _id: top[0], count: top[1] } : null);
  } catch (err) {
    console.error("Top dish error:", err);
    res.status(500).json({ error: "Could not get top dish" });
  }
});

// Repeat customers (IST)
app.get("/api/dashboard/repeatcustomers", async (req, res) => {
  try {
    let start, end;

    if (req.query.from && req.query.to) {
      ({ start, end } = getISTDateBounds(req.query.from));
      const toBounds = getISTDateBounds(req.query.to);
      end = toBounds.end;
    } else {
      const date = req.query.date || new Date().toISOString().slice(0, 10);
      ({ start, end } = getISTDateBounds(date));
    }

    const nameFilter = req.query.name ? { customerName: req.query.name } : {};

    const orders = await Order.find({
      createdAt: { $gte: start, $lte: end },
      status: { $ne: "deleted" },
      ...nameFilter
    });

    const stats = {};
    orders.forEach((o) => {
      if (!o.customerName) return;
      stats[o.customerName] = (stats[o.customerName] || 0) + 1;
    });

    if (req.query.name) {
      return res.json([
        { _id: req.query.name, orders: stats[req.query.name] || 0 }
      ]);
    }

    const sorted = Object.entries(stats)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ _id: name, orders: count }));

    res.json(sorted);
  } catch (err) {
    console.error("Repeat customers error:", err);
    res.status(500).json({ error: "Could not get repeat customers" });
  }
});

// --------------- AUTO-PRINT TICKET API ---------------
app.get("/api/next-print-ticket", (req, res) => {
  if (printQueue.length === 0) {
    return res.status(204).send();
  }

  const order = printQueue.shift();

  let lines = [];
  lines.push("ABBA SEENUUU... FAST FOODS");
  lines.push('Tagline: Taste like "ahh devudaa..."');
  lines.push("--------------------------");
  lines.push(`Order ID: ${order._id}`);
  lines.push(`Type   : ${order.orderType}`);
  if (order.customerName) lines.push(`Name   : ${order.customerName}`);
  if (order.registrationNumber) lines.push(`Reg No : ${order.registrationNumber}`);
  if (order.mobile) lines.push(`Mobile : ${order.mobile}`);
  if (order.tableNumber) lines.push(`Table  : ${order.tableNumber}`);
  if (order.address) lines.push(`Addr   : ${order.address}`);
  if (order.specialRequest) lines.push(`Note   : ${order.specialRequest}`);
  if (order.requestTags && order.requestTags.length) {
    lines.push(`Tags   : ${order.requestTags.join(", ")}`);
  }
  lines.push(
    "Payment: " +
      (order.paymentMethod || "COD") +
      (order.paymentVerified ? " (VERIFIED)" : " (PENDING)")
  );
  lines.push("--------------------------");

  (order.items || []).forEach((it) => {
    lines.push(`${it.name}${it.variant ? ` (${it.variant})` : ""} x${it.qty}  ₹${it.price}`);
  });

  lines.push("--------------------------");
  lines.push(`Total: ₹${order.total}`);
  lines.push("\n\n\n");

  res.type("text/plain").send(lines.join("\n"));
});

// ---------------- SOCKET.IO ----------------
io.on("connection", (socket) => {
  console.log("🟢 Abba SEENUUU... FAST FOODS client connected");
  socket.emit("connected", { status: "connected" });
});

// ---------------- HEALTH CHECK ----------------
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

// ---------------- SERVER ----------------
server.listen(PORT, () => {
  console.log(`🚀 Abba SEENUUU... FAST FOODS server running on http://localhost:${PORT}`);
  console.log(`👤 Manager username: ${managerUser}`);
  console.log(`🔑 Manager password: ${managerPass}`);
});
