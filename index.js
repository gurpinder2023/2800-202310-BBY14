require("./utils.js");
require("dotenv").config();

const uuid = require('uuid').v4;

const express = require("express");
const session = require("express-session");
const MongoStore = require("connect-mongo");
const bcrypt = require("bcrypt");

// SendGrid email service
const sgMail = require("@sendgrid/mail");
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const saltRounds = 12;

const port = process.env.PORT || 3080;

const app = express();
const Joi = require("joi");
const expireTime = 1000 * 60 * 60 * 24; // expires after 24 hours

/* --- SECRETS --- */
const mongodb_host = process.env.MONGODB_HOST;
const mongodb_user = process.env.MONGODB_USER;
const mongodb_password = process.env.MONGODB_PASSWORD;
const mongodb_database = process.env.MONGODB_DATABASE;
const mongodb_session_secret = process.env.MONGODB_SESSION_SECRET;
const node_session_secret = process.env.NODE_SESSION_SECRET;
/* ----- END ----- */

var { database } = include("databaseConnection");

const resetTokenCollection = database.db(mongodb_database).collection("resetTokens");

const userCollection = database.db(mongodb_database).collection("users");

const reportCollection = database.db(mongodb_database).collection("reports");

app.set("view engine", "ejs");

app.use(express.urlencoded({ extended: false }));

var mongoStore = MongoStore.create({
  mongoUrl: `mongodb+srv://${mongodb_user}:${mongodb_password}@${mongodb_host}/bby14`,
  crypto: {
    secret: mongodb_session_secret,
  },
});

app.use(
  session({
    secret: node_session_secret,
    store: mongoStore,
    saveUninitialized: false,
    resave: true,
  })
);

function sessionValidation(req, res, next) {
  if (req.session.authenticated) {
    next();
  } else {
    res.render("index");
  }
}

/* --- ADMIN VALIDATION --- 
function adminValidation(req, res, next) {
  if (req.session.user_type === "admin") {
    next();
  } else {
    res.status(403);
    res.render("403",{error: "Not Authorized"});
  }
}
 --------- END --------- */

app.get("/", sessionValidation, (req, res) => {
  var name = req.session.name;
  res.render("index_user", { name: name });
});

app.get("/signup", (req, res) => {
  res.render("signup");
});

app.post("/submitUser", async (req, res) => {
  var name = req.body.name;
  var email = req.body.email;
  var password = req.body.password;
  var confirm_password = req.body.confirm_password;
  var birthday = req.body.birthday;

  const schema = Joi.object({
    name: Joi.string().alphanum().max(20).required(),
    email: Joi.string().email().required(),
    password: Joi.string().max(20).required(),
    confirm_password: Joi.string().max(20),
    birthday: Joi.date().required(),
  }).options({ abortEarly: false }); // check all fields before returning

  const validationResult = schema.validate({ name, email, password, birthday });

  if (validationResult.error != null) {
    var errors = validationResult.error.details; // array of error objects from Joi validation
    var errorMessages = []; // array for error messages
    for (var i = 0; i < errors.length; i++) {
      errorMessages.push(errors[i].message);
    }
    var errorMessage = errorMessages.join(", ");
    res.render("signup_error", { error: errorMessage });
    return;
  }

  // check if password matches confirm_password
  if (password !== confirm_password) {
    res.render("signup_error", { error: "Passwords do not match (｡•́︿•̀｡)" }); // change to display error message under field later
    return;
  }

  // check if email is already in use
  const result = await userCollection
    .find({ email: email })
    .project({ email: email })
    .toArray();

  if (result.length > 0) {
    res.render("signup_error", { error: "Email already in use (｡•́︿•̀｡)" });
    return;
  }

  // hash password
  var hashedPassword = await bcrypt.hash(password, saltRounds);

  // insert user into database
  await userCollection.insertOne({
    name: name,
    email: email,
    password: hashedPassword,
    birthday: birthday,
    token: "", // empty field for password reset token
  });

  // successful signup - log in user and redirect to main page
  req.session.authenticated = true;
  req.session.name = name;
  res.redirect("/main");
});

app.get("/login", (req, res) => {
  res.render("login");
});

app.post("/loggingin", async (req, res) => {
  var email = req.body.email;
  var password = req.body.password;

  const schema = Joi.object({
    email: Joi.string().email().required(),
    password: Joi.string().max(20).required(),
  }).options({ abortEarly: false });

  const validationResult = schema.validate({ email, password });

  if (validationResult.error != null) {
    var errors = validationResult.error.details;
    var errorMessages = [];
    for (var i = 0; i < errors.length; i++) {
      errorMessages.push(errors[i].message);
    }
    var errorMessage = errorMessages.join(", ");
    res.render("login-error", { error: errorMessage });
    return;
  }

  const result = await userCollection
    .find({ email: email })
    .project({ name: 1, email: 1, password: 1, _id: 1 })
    .toArray();

  if (result.length != 1) {
    res.render("login-error", { error: "User not found (｡•́︿•̀｡)" });
    return;
  }

  if (await bcrypt.compare(password, result[0].password)) {
    req.session.authenticated = true;
    req.session.name = result[0].name;
    req.session.email = email;
    req.session.cookie.maxAge = expireTime;
    res.redirect("/loggedin");
    return;
  } else {
    res.render("login-error", { error: "Incorrect password (｡•́︿•̀｡)" });
    return;
  }
});

app.get("/forgotpassword", (req, res) => {
  res.render("forgotpassword");
});

app.post("/sendresetemail", async (req, res) => {
  var email = req.body.email;

  // check if the email exists in the database
  const user = await userCollection.findOne({ email: email });
  if (user == null) {
    res.render("login-error", { error: "Email not found (｡•́︿•̀｡)" });
    return;
  }

  const token = uuid().replace(/-/g, "");
  const resetLink = `http://localhost:3080/resetpassword?token=${token}`;

  // update the user's token in the database
  await resetTokenCollection.insertOne({
    token,
    userId: user._id,
    createdAt: new Date(),
  });

  // send email with the random number
  const msg = {
    to: email,
    from: "aisleep.bby14@gmail.com",
    templateId: "d-8165dda8d38d4a059e436d812148a15a",
    dynamicTemplateData: {
      subject: "AISleep Password Reset",
      resetLink: resetLink,
    },
  };

  try {
    await sgMail.send(msg);
    // res.status(200).send('Email sent');
    res.render("checkemail");
    return;
  }
  catch (error) {
    res.status(500).send("Error sending email");
  }
});

app.get("/resetpassword", async (req, res) => {
  // find user with matching decrypted token in the database
  const token = await resetTokenCollection.findOne({ token: req.query.token });

  if (token === null || new Date() - token.createdAt > (1000 * 60 * 15)) {
    res.render("login-error", { error: "Invalid or expired token (｡•́︿•̀｡)" });
    return;
  }

  res.locals.token = token.token;
  res.render("resetpassword");
});

app.post("/resetpassword", async (req, res) => {
  const token = await resetTokenCollection.findOne({ token: req.body.token });
  const password = req.body.password;
  const confirm_password = req.body.confirm_password;

  if (token === null) {
    res.render("login-error", { error: "Invalid token (｡•́︿•̀｡)" });
    return;
  }

  // check if password matches confirm_password
  if (password !== confirm_password) {
    res.render("reset-error", { error: "Passwords do not match (｡•́︿•̀｡)", link: `/resetpassword?email=${email}&token=${token}` });
    return;
  }

  // hash password
  var hashedPassword = await bcrypt.hash(password, saltRounds);

  // update the user's password and token in the database
  await userCollection.updateOne(
    { _id: token.userId },
    { $set: { password: hashedPassword, token: "" } }
  );

  // remove token from resetTokenCollection
  await resetTokenCollection.deleteOne({ _id: token._id });

  res.redirect("/login");
});

// Redirect to main page if user is logged in
app.get("/loggedin", sessionValidation, (req, res) => {
  res.redirect("/main");
});

// End session and redirect to login/signup page
app.get("/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/");
});

app.get("/createreport", sessionValidation, (req, res) => {
  res.render("createreport");
});

app.post("/submitreport", sessionValidation, async (req, res) => {

  let sleepScore = 100; // set the sleepScore to 100 at the beginning so that it resets back to 100 everytime a new report submits

  const userName = req.session.name;
  const email = req.session.email;
  const bedtimeHour = req.body.bedtimeHour;
  const bedtimeMinute = req.body.bedtimeMinute;
  const bedtimeAmPm = req.body.bedtimeAmPm;
  const wakeupHour = req.body.wakeupHour;
  const wakeupMinute = req.body.wakeupMinute;
  const wakeupAmPm = req.body.wakeupAmPm;
  const wakeupCount = req.body.wakeupcount;
  const alcohol = req.body.alcohol;
  
  let alcoholCount, wakeupCountInt;

  if (alcohol === "No") {
    alcoholCount = 0;
  } else if (req.body.alcohol === "10+ oz") {
    alcoholCount = 10;
  } else {
    alcoholCount = parseInt(req.body.alcoholcount);
  }
  
  if (wakeupCount === "10+ times") {
    wakeupCountInt = 10;
  } else {
    wakeupCountInt = parseInt(wakeupCount);
  }

  // Combine the bedtime hour, minute, and AM/PM into a single string in the format "8:30 AM"
  const bedtime = `${bedtimeHour}:${bedtimeMinute} ${bedtimeAmPm}`;

  // Combine the wakeup hour, minute, and AM/PM into a single string in the format "8:30 AM"
  const wakeup = `${wakeupHour}:${wakeupMinute} ${wakeupAmPm}`;

  // Calculate sleep score  NEEDS MORE WORK, JUST A DEMONSTRATION
  if (wakeupCountInt > 0) {
    sleepScore = sleepScore - 30;
  }

  // Create a new report object with the current date and time
  const currentDate = new Date();
  const options = { 
    year: 'numeric', 
    month: 'long',
    day: 'numeric',
    hour: 'numeric', 
    minute: 'numeric', 
    hour12: true 
  };
  const formattedDate = currentDate.toLocaleString('en-US', options);
  const report = {
    userName,
    email,
    bedtime,
    wakeup,
    wakeupCount: wakeupCountInt,
    alcohol,
    alcoholCount,
    sleepScore,
    date: formattedDate // use the formatted date and time
  };

  // Save the report to the database
  try {
    const result = await reportCollection.insertOne(report);
    console.log(`Inserted report with ID ${result.insertedId}`);
    res.redirect('/main');
  } catch (error) {
    console.error(error);
    res.status(500).send('Error submitting report');
  }
});

app.get("/main", sessionValidation, (req, res) => {
  var name = req.session.name;
  var sleepScore = 100;
  res.render("main", { name: name, sleepScore: sleepScore });
});

app.get("/about", (req, res) => {
  res.render("about");
});

app.get("/tips", sessionValidation, (req, res) => {
  res.render("tips");
});

app.get('/tips-data', function(req, res) {
  const tipsData = require('./app/data/tips.json');
  res.json(tipsData);
});

//The route for public folder
app.use(express.static(__dirname + "/public"));

app.get("*", (req, res) => {
  res.status(404);
  res.render("404");
})

app.listen(port, () => {
  console.log("Node application listening on port " + port);
}); 