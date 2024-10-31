const express = require("express");
const app = express();
require("dotenv").config();
const cors = require("cors");
const nodemailer = require("nodemailer");
const cookieParser = require("cookie-parser");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const jwt = require("jsonwebtoken");
const stripe = require("stripe")(process.env.VITE_SECRET_KEY);

const port = process.env.PORT || 8000;

// middleware
const corsOptions = {
  origin: [
    "http://localhost:5173",
    "http://localhost:5174",
    "https://stay-vista-15d4b.web.app",
    "https://stay-vista-15d4b.firebaseapp.com",
  ],
  credentials: true,
  optionSuccessStatus: 200,
};
app.use(cors(corsOptions));

app.use(express.json());
app.use(cookieParser());

// send email
const sendEmail = (emailAddress, emailData) => {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    host: "smtp.gmail.com",
    port: 587,
    secure: false, // true for port 465, false for other ports
    auth: {
      user: process.env.TRANSPORTER_EMAIL,
      pass: process.env.TRANSPORTER_PASS,
    },
  });

  // verify connection configuration
  transporter.verify(function (error, success) {
    if (error) {
      console.log(error);
    } else {
      console.log("Server is ready to take our messages");
    }
  });

  // send mail with defined transport object
  const mailBody = {
    from: `"Rent Vista" <${process.env.TRANSPORTER_EMAIL}>`, // sender address
    to: emailAddress, // list of receivers
    subject: emailData.subject, // Subject line
    html: emailData.message, // html body
  };
  transporter.sendMail(mailBody, (error, info) => {
    if (error) {
      console.log(error);
    } else {
      console.log("Email Sent :" + info.response);
    }
  });
};

// Verify Token Middleware
const verifyToken = async (req, res, next) => {
  const token = req.cookies?.token;
  console.log(token);
  if (!token) {
    return res.status(401).send({ message: "unauthorized access" });
  }
  jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, decoded) => {
    if (err) {
      console.log(err);
      return res.status(401).send({ message: "unauthorized access" });
    }
    req.user = decoded;
    next();
  });
};

// const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@main.mq0mae1.mongodb.net/?retryWrites=true&w=majority&appName=Main`
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.wrhbune.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    const roomsCollection = client.db("stayVista").collection("rooms");
    const usersCollection = client.db("stayVista").collection("users");
    const bookingsCollection = client.db("stayVista").collection("bookings");

    // verify admin middleware
    const verifyAdmin = async (req, res, next) => {
      // console.log("hello");
      const user = req.user;
      const query = { email: user?.email };
      const result = await usersCollection.findOne(query);
      if (!result || result?.role !== "admin")
        return res.send({ message: "unauthorized access!!" });
      next();
    };
    // verify host middleware
    const verifyHost = async (req, res, next) => {
      // console.log("hello");
      const user = req.user;
      const query = { email: user?.email };
      const result = await usersCollection.findOne(query);
      if (!result || result?.role !== "host")
        return res.send({ message: "unauthorized access!!" });
      next();
    };

    // auth related api
    app.post("/jwt", async (req, res) => {
      const user = req.body;
      const token = jwt.sign(user, process.env.ACCESS_TOKEN_SECRET, {
        expiresIn: "365d",
      });
      res
        .cookie("token", token, {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
        })
        .send({ success: true });
    });
    // Logout
    app.get("/logout", async (req, res) => {
      try {
        res
          .clearCookie("token", {
            maxAge: 0,
            secure: process.env.NODE_ENV === "production",
            sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
          })
          .send({ success: true });
        console.log("Logout successful");
      } catch (err) {
        res.status(500).send(err);
      }
    });

    // create-payment-intent
    app.post("/create-payment-intent", verifyToken, async (req, res) => {
      const price = req.body.price;
      const priceInCent = parseFloat(price) * 100;
      if (!price || priceInCent < 1) return;
      // generate client secret
      const { client_secret } = await stripe.paymentIntents.create({
        amount: priceInCent,
        currency: "usd",
        // In the latest version of the API, specifying the `automatic_payment_methods` parameter is optional because Stripe enables its functionality by default.
        automatic_payment_methods: {
          enabled: true,
        },
      });
      // send client secret as a response
      res.send({ clientSecret: client_secret });
    });

    // user data save in db

    app.get("/users", verifyToken, verifyAdmin, async (req, res) => {
      const result = await usersCollection.find().toArray();
      res.send(result);
    });

    app.get("/user/:email", async (req, res) => {
      const email = req.params.email;
      const result = await usersCollection.findOne({ email });
      res.send(result);
    });

    // update a user role
    app.patch("/users/update/:email", async (req, res) => {
      const email = req.params.email;
      const user = req.body;
      const query = { email };
      const updateDoc = {
        $set: {
          ...user,
          timestamp: Date.now(),
        },
      };
      const result = await usersCollection.updateOne(query, updateDoc);
      res.send(result);
    });

    app.put("/user", async (req, res) => {
      const user = req.body;
      const query = { email: user?.email };

      const isExist = await usersCollection.findOne(query);
      if (isExist) {
        if (user.status === "Requested") {
          // if existing user try to change his/her role
          const result = await usersCollection.updateOne(query, {
            $set: { status: user.status },
          });
          return res.send(result);
        } else {
          // if existing user login again
          return res.send(isExist);
        }
      }

      // save user for the first time
      const options = { upsert: true };
      const updateDoc = {
        $set: {
          ...user,
          timestamp: Date.now(),
        },
      };
      const result = await usersCollection.updateOne(query, updateDoc, options);
      // welcome new user and email
      sendEmail(user?.email, {
        subject: "Welcome to RentVista!",
        message: `Hope you will find your destination`,
      });
      res.send(result);
    });

    // room collection api

    app.get("/rooms", async (req, res) => {
      const category = req.query.category;
      let query = {};
      if (category && category !== "null") {
        query = { category: category };
      }
      const result = await roomsCollection.find(query).toArray();
      console.log(result);

      res.send(result);
    });

    app.get("/room/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await roomsCollection.findOne(query);
      res.send(result);
    });

    app.post("/room", verifyToken, verifyHost, async (req, res) => {
      const roomInfo = req.body;
      const result = await roomsCollection.insertOne(roomInfo);
      res.send(result);
    });

    app.get(
      "/my-listings/:email",
      verifyToken,
      verifyHost,
      async (req, res) => {
        const email = req.params.email;
        const query = { "host.email": email };
        const result = await roomsCollection.find(query).toArray();
        res.send(result);
      }
    );

    app.delete("/room/:id", verifyToken, verifyHost, async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await roomsCollection.deleteOne(query);
      res.send(result);
    });

    // room bookings collection

    app.post("/booking", verifyToken, async (req, res) => {
      const bookingInfo = req.body;
      // save room bookings info
      const result = await bookingsCollection.insertOne(bookingInfo);

      // send email to guest
      sendEmail(bookingInfo?.guest?.email, {
        subject: "Booking Successful",
        message: `You've successfully booked a room through RentVista. Transaction Id :${bookingInfo.transactionId}`,
      });
      // send email to host
      sendEmail(bookingInfo?.host?.email, {
        subject: "Your Room Got Booked",
        message: `Get ready to welcome ${bookingInfo?.guest.name}.`,
      });

      res.send(result);
    });

    app.put("/room/update/:id", async (req, res) => {
      const id = req.params.id;
      const roomData = req.body;
      const query = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: {
          ...roomData,
        },
      };
      const result = await roomsCollection.updateOne(query, updateDoc);
      res.send(result);
    });

    app.patch("/room/status/:id", verifyToken, async (req, res) => {
      const id = req.params.id;
      const status = req.body.status;
      // change room availability status
      const query = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: {
          booked: status,
        },
      };
      const result = await roomsCollection.updateOne(query, updateDoc);
      res.send(result);
    });
    // get my bookings for guest
    app.get("/my-bookings/:email", verifyToken, async (req, res) => {
      const email = req.params.email;
      const query = { "guest.email": email };
      const result = await bookingsCollection.find(query).toArray();
      res.send(result);
    });
    // get my bookings for host
    app.get(
      "/manage-bookings/:email",
      verifyToken,
      verifyHost,
      async (req, res) => {
        const email = req.params.email;
        const query = { "host.email": email };
        const result = await bookingsCollection.find(query).toArray();
        res.send(result);
      }
    );

    app.delete("/booking/:id", verifyToken, async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await bookingsCollection.deleteOne(query);
      res.send(result);
    });

    // admin stat
    app.get("/admin-stat", verifyToken, verifyAdmin, async (req, res) => {
      const bookingDetails = await bookingsCollection
        .find(
          {},
          {
            projection: {
              price: 1,
              date: 1,
            },
          }
        )
        .toArray();
      const totalUser = await usersCollection.countDocuments();
      const totalRoom = await roomsCollection.countDocuments();
      const totalPrice = bookingDetails.reduce(
        (sum, booking) => sum + booking.price,
        0
      );
      const chartData = bookingDetails.map((booking) => {
        const date = new Date(booking.date).getDate();
        const month = new Date(booking.date).getMonth() + 1;
        const data = [`${date}/${month}`, booking?.price];
        return data;
      });
      // unShift and splice work are same but unShift are stander
      chartData.unshift(["Day", "Sales"]);
      // chartData.splice(0, 0, ["Day", "Sales"]);
      // console.log(chartData);
      // console.log(bookingDetails);
      res.send({
        totalPrice,
        totalUser,
        totalRoom,
        totalBooking: bookingDetails.length,
        chartData,
      });
    });

    // host stat
    app.get("/host-stat", verifyToken, verifyHost, async (req, res) => {
      const { email } = req.user;

      const bookingDetails = await bookingsCollection
        .find(
          { "host.email": email },
          {
            projection: {
              price: 1,
              date: 1,
            },
          }
        )
        .toArray();
      const totalRoom = await roomsCollection.countDocuments({
        "host.email": email,
      });
      const totalPrice = bookingDetails.reduce(
        (sum, booking) => sum + booking.price,
        0
      );

      const { timestamp } = await usersCollection.findOne(
        { email },
        {
          projection: {
            timestamp: 1,
          },
        }
      );

      const chartData = bookingDetails.map((booking) => {
        const date = new Date(booking.date).getDate();
        const month = new Date(booking.date).getMonth() + 1;
        const data = [`${date}/${month}`, booking?.price];
        return data;
      });
      // unShift and splice work are same but unShift are stander
      chartData.unshift(["Day", "Sales"]);
      // chartData.splice(0, 0, ["Day", "Sales"]);
      // console.log(chartData);
      // console.log(bookingDetails);
      res.send({
        totalPrice,
        totalRoom,
        totalBooking: bookingDetails.length,
        chartData,
        hostSince: timestamp,
      });
    });

    // guest stat
    app.get("/guest-stat", verifyToken, async (req, res) => {
      const { email } = req.user;

      const bookingDetails = await bookingsCollection
        .find(
          { "guest.email": email },
          {
            projection: {
              price: 1,
              date: 1,
            },
          }
        )
        .toArray();

      const totalPrice = bookingDetails.reduce(
        (sum, booking) => sum + booking.price,
        0
      );

      const { timestamp } = await usersCollection.findOne(
        { email },
        {
          projection: {
            timestamp: 1,
          },
        }
      );

      const chartData = bookingDetails.map((booking) => {
        const date = new Date(booking.date).getDate();
        const month = new Date(booking.date).getMonth() + 1;
        const data = [`${date}/${month}`, booking?.price];
        return data;
      });
      // unShift and splice work are same but unShift are stander
      chartData.unshift(["Day", "Sales"]);
      // chartData.splice(0, 0, ["Day", "Sales"]);
      // console.log(chartData);
      // console.log(bookingDetails);
      res.send({
        totalPrice,
        totalBooking: bookingDetails.length,
        chartData,
        guestSince: timestamp,
      });
    });

    // Send a ping to confirm a successful connection
    // await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Hello from StayVista Server..");
});

app.listen(port, () => {
  console.log(`StayVista is running on port ${port}`);
});
