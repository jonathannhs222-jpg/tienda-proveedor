// server.js
// Backend mínimo: crea el cobro (Stripe o PayPal) y, cuando se confirma,
// envía automáticamente el email de "gracias + contacto del proveedor" por Gmail.

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
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

// ---------- EMAIL AUTOMÁTICO (Brevo) ----------

async function enviarEmailGracias(destinatario, claveProducto = "proveedor") {
  const producto = obtenerProducto(claveProducto);

  // Número del proveedor y mensaje que aparecerá ya escrito al abrir el chat.
  const numeroProveedor = "8613159459186"; // +86 131 5945 9186, sin "+" ni espacios
  const mensajePrecargado = encodeURIComponent(
    "Hola buenas, vengo de parte de Jonathan, me gustaría comprar algún producto."
  );
  const enlaceWhatsapp = `https://wa.me/${numeroProveedor}?text=${mensajePrecargado}`;

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
      <p>Ya tienes acceso a <b>${producto.nombre}</b>. Pulsa el botón de abajo
      para hablar directamente con el proveedor por WhatsApp — el mensaje ya
      viene escrito, solo tienes que enviarlo:</p>

      <div style="text-align:center; margin:28px 0;">
        <a href="${enlaceWhatsapp}"
           style="display:inline-block; background:#25D366; color:#ffffff;
                  text-decoration:none; font-weight:bold; font-size:15px;
                  padding:14px 28px; border-radius:8px;">
          💬 Hablar con el proveedor por WhatsApp
        </a>
      </div>

      ${bloqueGuia}

      <p>Si tienes cualquier duda con el pedido, escríbeme directamente
      respondiendo a este correo.</p>

      <p style="margin-top:28px;">Un saludo,<br>[TU NOMBRE]</p>
    </div>
  `;

  await enviarConBrevo(destinatario, "Tu acceso al proveedor — gracias por tu compra", html);
}

// Envía el email a través de la API HTTP de Brevo (https://api.brevo.com).
// Usamos HTTP en vez de SMTP porque muchos hostings gratuitos (Render incluido)
// bloquean las conexiones salientes por los puertos de correo tradicionales.
async function enviarConBrevo(destinatario, asunto, html) {
  const respuesta = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "api-key": process.env.BREVO_API_KEY,
    },
    body: JSON.stringify({
      sender: { name: "SneakerSource", email: process.env.GMAIL_USER },
      to: [{ email: destinatario }],
      subject: asunto,
      htmlContent: html,
    }),
  });

  if (!respuesta.ok) {
    const detalle = await respuesta.text();
    throw new Error(`Brevo respondió ${respuesta.status}: ${detalle}`);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor escuchando en el puerto ${PORT}`));
