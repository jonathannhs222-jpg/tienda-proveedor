// server.js
// Backend mínimo: crea el cobro (Stripe o PayPal) y, cuando se confirma,
// envía automáticamente el email de "gracias + contacto del proveedor" por Gmail.

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
const nodemailer = require("nodemailer");
const paypal = require("@paypal/checkout-server-sdk");

const app = express();

// Red de seguridad: si algo falla en cualquier punto de forma inesperada,
// lo registramos en los logs pero NO dejamos que tumbe el servidor entero.
process.on("unhandledRejection", (reason) => {
  console.error("Promesa no controlada:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("Excepción no controlada:", err);
});

// Stripe necesita el body "raw" SOLO en la ruta del webhook,
// por eso esa ruta se declara antes de app.use(express.json())
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

app.post(
  "/webhook-stripe",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers["stripe-signature"],
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("Firma de webhook inválida:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const emailCliente = session.customer_details?.email;
      const producto = session.metadata?.producto || "proveedor";
      if (emailCliente) {
        try {
          await enviarEmailGracias(emailCliente, producto);
        } catch (errEmail) {
          console.error("No se pudo enviar el email de agradecimiento:", errEmail);
          // No relanzamos el error: el pago ya está confirmado, no queremos
          // que un fallo de email tumbe el servidor ni afecte a Stripe.
        }
      }
    }

    res.json({ received: true });
  }
);

app.use(cors());
app.use(express.json());

// ---------- CONFIGURACIÓN DE PRODUCTOS ----------
// Dos opciones: solo el acceso al proveedor, o el pack con la guía de reventa.
const PRODUCTOS = {
  proveedor: {
    nombre: "Proveedor Zapatillas China — Acceso Directo",
    descripcion: "Catálogo, tarifas mayorista/unidad y contacto directo del proveedor",
    precioCentimos: 1700, // 17,00 €
    moneda: "eur",
    incluyeGuia: false,
  },
  pack: {
    nombre: "Proveedor Zapatillas China + Guía de Reventa",
    descripcion: "Todo lo del acceso al proveedor, más la guía completa para revender con margen",
    precioCentimos: 2700, // 27,00 €
    moneda: "eur",
    incluyeGuia: true,
  },
};

function obtenerProducto(clave) {
  return PRODUCTOS[clave] || PRODUCTOS.proveedor;
}

// ---------- STRIPE: crear sesión de pago ----------
app.post("/crear-sesion-stripe", async (req, res) => {
  try {
    const producto = obtenerProducto(req.body.producto);
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: producto.moneda,
            product_data: {
              name: producto.nombre,
              description: producto.descripcion,
            },
            unit_amount: producto.precioCentimos,
          },
          quantity: 1,
        },
      ],
      metadata: { producto: req.body.producto || "proveedor" },
      success_url: `${process.env.FRONTEND_URL}/gracias.html`,
      cancel_url: `${process.env.FRONTEND_URL}/proveedor.html`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "No se pudo crear la sesión de pago" });
  }
});


// ---------- PAYPAL: cliente ----------
function clientePaypal() {
  const environment =
    process.env.PAYPAL_ENV === "live"
      ? new paypal.core.LiveEnvironment(
          process.env.PAYPAL_CLIENT_ID,
          process.env.PAYPAL_CLIENT_SECRET
        )
      : new paypal.core.SandboxEnvironment(
          process.env.PAYPAL_CLIENT_ID,
          process.env.PAYPAL_CLIENT_SECRET
        );
  return new paypal.core.PayPalHttpClient(environment);
}

// ---------- PAYPAL: crear orden ----------
app.post("/crear-orden-paypal", async (req, res) => {
  const producto = obtenerProducto(req.body.producto);
  const claveProducto = PRODUCTOS[req.body.producto] ? req.body.producto : "proveedor";
  const request = new paypal.orders.OrdersCreateRequest();
  request.prefer("return=representation");
  request.requestBody({
    intent: "CAPTURE",
    purchase_units: [
      {
        amount: {
          currency_code: "EUR",
          value: (producto.precioCentimos / 100).toFixed(2),
        },
        description: producto.nombre,
        custom_id: claveProducto,
      },
    ],
  });
  try {
    const order = await clientePaypal().execute(request);
    res.json({ id: order.result.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "No se pudo crear la orden de PayPal" });
  }
});

// ---------- PAYPAL: capturar orden (aquí se confirma el cobro) ----------
app.post("/capturar-orden-paypal/:orderID", async (req, res) => {
  const request = new paypal.orders.OrdersCaptureRequest(
    req.params.orderID
  );
  request.requestBody({});
  try {
    const capture = await clientePaypal().execute(request);
    const status = capture.result.status;
    const emailCliente = capture.result.payer?.email_address;
    const claveProducto =
      capture.result.purchase_units?.[0]?.custom_id || "proveedor";

    if (status === "COMPLETED" && emailCliente) {
      try {
        await enviarEmailGracias(emailCliente, claveProducto);
      } catch (errEmail) {
        console.error("No se pudo enviar el email de agradecimiento:", errEmail);
      }
    }
    res.json({ status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "No se pudo capturar el pago de PayPal" });
  }
});

// ---------- EMAIL AUTOMÁTICO (Gmail) ----------
const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false, // usa STARTTLS en vez de SSL directo (más fiable en algunos hostings)
  auth: {
    user: process.env.GMAIL_USER,        // tu-correo@gmail.com
    pass: process.env.GMAIL_APP_PASSWORD, // contraseña de aplicación (no tu contraseña normal)
  },
  connectionTimeout: 20000, // 20s en vez del valor por defecto, más margen
});

async function enviarEmailGracias(destinatario, claveProducto = "proveedor") {
  const producto = obtenerProducto(claveProducto);

  const bloqueGuia = producto.incluyeGuia
    ? `
      <div style="background:#eef6f0; border-radius:10px; padding:18px; margin:20px 0;">
        <p style="margin:0 0 8px;"><b>📘 Tu guía de reventa</b></p>
        <p style="margin:0;">La tienes adjunta a este correo en PDF. Repásala antes
        de hacer tu primer pedido, te ahorrará bastantes errores de principiante.</p>
      </div>
    `
    : "";

  const html = `
    <div style="font-family:Arial,sans-serif; max-width:520px; margin:auto; color:#222;">
      <h2 style="color:#c07a1f;">¡Gracias por tu compra!</h2>
      <p>Ya tienes acceso a <b>${producto.nombre}</b>. Aquí tienes el contacto
      directo del proveedor para que empieces a pedir cuando quieras, ya sea
      por unidades o al por mayor:</p>

      <div style="background:#f6f2ea; border-radius:10px; padding:18px; margin:20px 0;">
        <p style="margin:0 0 6px;"><b>Persona de contacto:</b> [NOMBRE DEL CONTACTO]</p>
        <p style="margin:0 0 6px;"><b>Email:</b> [EMAIL DEL PROVEEDOR]</p>
        <p style="margin:0 0 6px;"><b>WhatsApp:</b> [TELÉFONO DEL PROVEEDOR]</p>
        <p style="margin:0;"><b>Catálogo:</b> [ENLACE AL CATÁLOGO]</p>
      </div>

      ${bloqueGuia}

      <p>Si tienes cualquier duda con el pedido o el proveedor no responde,
      escríbeme directamente respondiendo a este correo.</p>

      <p style="margin-top:28px;">Un saludo,<br>[TU NOMBRE]</p>
    </div>
  `;

  await transporter.sendMail({
    from: `"[TU MARCA]" <${process.env.GMAIL_USER}>`,
    to: destinatario,
    subject: "Tu acceso al proveedor — gracias por tu compra",
    html,
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor escuchando en el puerto ${PORT}`));
