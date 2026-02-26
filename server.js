// server.js – Abba SEENUUU... FAST FOODS (NO Razorpay)

const express  = require('express');
const http     = require('http');
const socketio = require('socket.io');
const cors     = require('cors');
const path     = require('path');
const mongoose = require('mongoose');
const fs       = require('fs');

require('dotenv').config();

const app    = express();
const server = http.createServer(app);
const io     = socketio(server);
const PORT   = process.env.PORT || 4000;

// --- Manager Portal Login (simple in‑memory, changeable) ---
let managerUser = "admin";
let managerPass = "abbaseenu2025"; // change as you like

// --- MongoDB connection (Abba SEENUUU... FAST FOODS) ---
// you can still override via env MONGO_URI on Render
const MONGO_URI =
  process.env.MONGO_URI ||
  "mongodb+srv://architkumarsncp2123_db_user:abbaseenu@abbaseenudb.5sndjat.mongodb.net/?appName=AbbaSeenudb";

mongoose.connect(MONGO_URI, {
  dbName: "AbbaSeenudb"
});
mongoose.connection.on("connected", () =>
  console.log("✅ Connected to MongoDB (Abba SEENUUU... FAST FOODS)")
);
mongoose.connection.on("error", (err) =>
  console.error("❌ MongoDB Error:", err)
);

// --- Schema ---
const orderSchema = new mongoose.Schema({
  orderType: String,              // dinein | takeaway | delivery
  customerName: String,
  registrationNumber: String,
  mobile: String,
  tableNumber: String,
  address: String,                // text address / block name
  location: {                     // for live map (customer location)
    lat: Number,
    lng: Number
  },
  paymentMethod: String,          // 'UPI' | 'COD'
  paymentVerified: {
    type: Boolean,
    default: false
  },
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
    default: "incoming"           // incoming | out_for_delivery | delivered | deleted
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  }
});

// Auto-delete orders after 90 days (3 months)
orderSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7776000 });

const Order = mongoose.model("Order", orderSchema);

// --- AUTO PRINT QUEUE ---
let printQueue = [];

async function saveAndBroadcastOrder(orderData) {
  const order = new Order(orderData);
  await order.save();
  io.emit("newOrder", order);   // real-time to manager + delivery portals
  printQueue.push(order);       // enqueue for auto print (if you use it)
  return order;
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// --- Manager Login API ---
app.post("/api/manager/login", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res
      .status(400)
      .json({ success: false, message: "Missing credentials" });
  }

  if (username === managerUser && password === managerPass) {
    return res.json({ success: true });
  }
  return res
    .status(401)
    .json({ success: false, message: "Invalid credentials" });
});

// --- Change Manager ID / Password ---
app.post("/api/manager/change-credentials", (req, res) => {
  const { currentUser, currentPassword, newUser, newPassword } = req.body || {};

  if (!currentUser || !currentPassword || !newUser || !newPassword) {
    return res
      .status(400)
      .json({ success: false, message: "All fields are required" });
  }

  if (currentUser !== managerUser || currentPassword !== managerPass) {
    return res
      .status(401)
      .json({ success: false, message: "Current ID / password is incorrect" });
  }

  managerUser = newUser;
  managerPass = newPassword;

  return res.json({ success: true });
});

// --- Serve menu file ---
app.get("/menu.json", (req, res) => {
  res.sendFile(path.join(__dirname, "public/menu.json"));
});

// Inventory: update menu.json
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

// --- Utility: IST date boundaries ---
function getISTDateBounds(dateStr) {
  const date  = dateStr || new Date().toISOString().slice(0, 10);
  const start = new Date(Date.parse(date + "T00:00:00+05:30"));
  const end   = new Date(Date.parse(date + "T23:59:59+05:30"));
  return { start, end };
}

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

// Place new order (QR / COD – NO Razorpay)
app.post("/api/orders", async (req, res) => {
  try {
    const {
      orderType,
      customerName,
      registrationNumber,
      mobile,
      tableNumber,
      address,
      location,        // { lat, lng } for delivery
      items,
      paymentMethod    // "UPI" or "COD"
    } = req.body;

    const total = (items || []).reduce(
      (s, i) => s + (i.price || 0) * (i.qty || 0),
      0
    );

    const order = await saveAndBroadcastOrder({
      orderType,
      customerName,
      registrationNumber,
      mobile,
      tableNumber,
      address,
      location,
      items,
      total,
      paymentMethod: paymentMethod || "COD",
      paymentVerified: false,
      status: "incoming"
    });

    res.json({ success: true, order });
  } catch (err) {
    console.error("Create order error:", err);
    res
      .status(500)
      .json({ success: false, error: "Could not create order" });
  }
});

// Update order status
app.patch("/api/orders/:id/status", async (req, res) => {
  try {
    const { id }    = req.params;
    const { status } = req.body;

    const order = await Order.findByIdAndUpdate(
      id,
      { status },
      { new: true }
    );

    if (!order) {
      return res
        .status(404)
        .json({ success: false, error: "Order not found" });
    }

    io.emit("orderUpdated", order);
    res.json({ success: true, order });
  } catch (err) {
    console.error("Update status error:", err);
    res
      .status(500)
      .json({ success: false, error: "Could not update status" });
  }
});

// Toggle payment verification
app.patch("/api/orders/:id/payment-verified", async (req, res) => {
  try {
    const { id } = req.params;
    const { paymentVerified } = req.body;

    const order = await Order.findByIdAndUpdate(
      id,
      { paymentVerified: !!paymentVerified },
      { new: true }
    );

    if (!order) {
      return res
        .status(404)
        .json({ success: false, error: "Order not found" });
    }

    io.emit("orderUpdated", order);
    res.json({ success: true, order });
  } catch (err) {
    console.error("Payment verify update error:", err);
    res
      .status(500)
      .json({ success: false, error: "Could not update payment verification" });
  }
});

// Hard delete (optional)
app.delete("/api/orders/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await Order.findByIdAndDelete(id);
    res.json({ success: true });
  } catch (err) {
    console.error("Delete order error:", err);
    res
      .status(500)
      .json({ success: false, error: "Could not delete order" });
  }
});

// ---------------- DASHBOARD APIs ----------------

// Total sales for a day/week/month (IST)
app.get("/api/dashboard/sales", async (req, res) => {
  try {
    const period = req.query.period || "day";
    const date   = req.query.date   || new Date().toISOString().slice(0, 10);

    let start, end;
    if (period === "day") {
      ({ start, end } = getISTDateBounds(date));
    } else if (period === "week") {
      const { start: dayStart } = getISTDateBounds(date);
      const d     = new Date(dayStart);
      const first = new Date(d.setDate(d.getDate() - d.getDay()));
      start = new Date(first.setHours(0, 0, 0, 0));
      end   = new Date(new Date(start).setDate(start.getDate() + 7));
    } else if (period === "month") {
      const { start: dayStart } = getISTDateBounds(date);
      const d = new Date(dayStart);
      start   = new Date(d.getFullYear(), d.getMonth(), 1);
      end     = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
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
    orders.forEach(o => {
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
    orders.forEach(o => {
      (o.items || []).forEach(i => {
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
    orders.forEach(o => {
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
    return res.status(204).send(); // nothing to print
  }

  const order = printQueue.shift(); // oldest order

  let lines = [];
  lines.push("ABBA SEENUUU... FAST FOODS");
  lines.push('Tagline: Taste like "ahh devudaa..."');
  lines.push("--------------------------");
  lines.push(`Order ID: ${order._id}`);
  lines.push(`Type   : ${order.orderType}`);
  if (order.customerName)       lines.push(`Name   : ${order.customerName}`);
  if (order.registrationNumber) lines.push(`Reg No : ${order.registrationNumber}`);
  if (order.mobile)             lines.push(`Mobile : ${order.mobile}`);
  if (order.address)            lines.push(`Addr   : ${order.address}`);
  lines.push(
    "Payment: " +
      (order.paymentMethod || "COD") +
      (order.paymentVerified ? " (VERIFIED)" : " (PENDING)")
  );
  lines.push("--------------------------");
  (order.items || []).forEach((it) => {
    lines.push(`${it.name} x${it.qty}  ₹${it.price}`);
  });
  lines.push("--------------------------");
  lines.push(`Total: ₹${order.total}`);
  lines.push("\\n\\n\\n");

  res.type("text/plain").send(lines.join("\\n"));
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
  console.log(
    `🚀 Abba SEENUUU... FAST FOODS server running on http://localhost:${PORT}`
  );
});
