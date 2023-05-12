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

const flash = require('connect-flash');

const port = process.env.PORT || 3080;

const app = express();

const Joi = require("joi");
const expireTime = 1000 * 60 * 60 * 24; // expires after 24 hours

const { ObjectId } = require('mongodb');

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
const reportProblem = database.db(mongodb_database).collection("reportProblem");


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
    res.render("403", { error: "Not Authorized" });
  }
}
 --------- END --------- */

app.use(flash());

// profile page setup
app.get("/profile", sessionValidation, (req, res) => {
  const isEditing = (req.query.edit === 'true');
  //   if (!req.session.authenticated) {
  //     res.redirect('/login');
  //     return;

  // }
  console.log(req.session);

  res.render('profile', {
    name: req.session.name,
    email: req.session.email,
    birthday: req.session.birthday,
    _id: req.session._id,
    isEditing: isEditing
  });
})

// POST handler for the /profile route
app.post('/profile', async (req, res) => {

  await userCollection.updateOne(
    { email: req.session.email },
    {
      $set: {
        name: req.body.name,

      }
    }
  );

  req.session.name = req.body.name;

  // Redirect the user back to the profile page, without the "edit" query parameter
  res.redirect('/profile');
});


app.use(express.static(__dirname + "/public"));

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
    res.render("signup_error", { error: "Passwords do not match" }); // change to display error message under field later
    return;
  }

  // check if email is already in use
  const result = await userCollection
    .find({ email: email })
    .project({ email: email })
    .toArray();

  if (result.length > 0) {
    res.render("signup_error", { error: "Email already in use" });
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
  req.session.email = email;
  req.session.birthday = birthday;
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
    .project({ name: 1, email: 1, password: 1, _id: 1, user_type: 1, birthday: 1 })
    .toArray();

  if (result.length != 1) {
    res.render("login-error", { error: "User not found" });
    return;
  }

  if (await bcrypt.compare(password, result[0].password)) {
    req.session.authenticated = true;
    req.session._id = result[0]._id;
    req.session.name = result[0].name;
    req.session.email = result[0].email;
    req.session.birthday = result[0].birthday;
    req.session.cookie.maxAge = expireTime;
    res.redirect("/loggedin");
    return;
  } else {
    res.render("login-error", { error: "Incorrect password" });
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
    res.render("login-error", { error: "Email not found" });
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
    res.render("login-error", { error: "Invalid or expired token" });
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
    res.render("login-error", { error: "Invalid token" });
    return;
  }

  // check if password matches confirm_password
  if (password !== confirm_password) {
    res.render("reset-error", { error: "Passwords do not match", link: `/resetpassword?email=${email}&token=${token}` });
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

app.get("/security", sessionValidation, (req, res) => {
  res.render("security", { messages: req.flash() });
});

app.post('/change-password', sessionValidation, async (req, res) => {
  const currentPassword = req.body.currentPassword;
  const newPassword = req.body.newPassword;
  const confirmNewPassword = req.body.confirmNewPassword;

  // Validate the input
  if (!currentPassword || !newPassword || !confirmNewPassword) {

    req.flash('error', 'All fields are required');
    return res.redirect('/security');
  }
  if (newPassword !== confirmNewPassword) {
    req.flash('error', 'New password and confirm password must match');
    return res.redirect('/security');
  }

  // Check if the current password is correct
  const email = req.session.email;
  const result = await userCollection
    .find({ email: email })
    .project({ name: 1, email: 1, password: 1, _id: 1, user_type: 1 })
    .toArray();
  if (!result) {
    req.flash('error', 'User not found');
    return res.redirect('/security');
  }
  const isMatch = await bcrypt.compare(currentPassword, result[0].password);
  if (!isMatch) {
    req.flash('error', 'Current password is incorrect');
    return res.redirect('/security');
  }

  // Update the password in the database
  const hashedPassword = await bcrypt.hash(newPassword, 10);
  await userCollection.updateOne({ email: email }, { $set: { password: hashedPassword } });
  req.flash('success', 'Password changed successfully!');
  return res.redirect('/security');

});


// deleting the user from the database.
app.post('/users/:userId', async (req, res) => {
  const userId = req.params.userId;

  try {
    const user = await userCollection.deleteOne({ _id: new ObjectId(userId) });
    if (!user) {
      return res.status(404).send('User not found');
    }

    res.redirect('/signup');
  } catch (error) {
    console.error(error);
    res.status(500).send('Server error');
  }
});

app.get("/createreport", sessionValidation, (req, res) => {
  res.render("createreport");
});

app.post("/submitreport", sessionValidation, async (req, res) => {

  let sleepScore = 100;
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

  const tips = [
    {
      sentence: 'You are a deep sleeper- keep up the good work: Deep sleep is the most restorative stage of sleep, and it is important to get enough of it each night.',
      applies: wakeupCountInt === 0
    },
    {
      sentence: 'You are doing great with waking up only once!',
      applies: wakeupCountInt === 1
    },
    {
      sentence: 'Try to reduce the number of times you wake up during the night.',
      applies: wakeupCountInt === 2
    },
    {
      sentence: 'You should consider seeing a sleep specialist if you are waking up three or more times during the night.',
      applies: wakeupCountInt >= 3
    },
    {
      sentence: 'Great job not drinking any alcohol before bed!',
      applies: alcoholCount === 0
    },
    {
      sentence: 'Drinking a small amount of alcohol before bed is generally okay, but try not to make it a habit.',
      applies: alcoholCount === 1
    },
    {
      sentence: 'Drinking more than 1 oz of alcohol before bed can disrupt your sleep.',
      applies: alcoholCount > 1 && alcoholCount <= 5
    },
    {
      sentence: 'Stop drinking- drinking more than 5 oz of alcohol before bed can significantly disrupt your sleep.',
      applies: alcoholCount > 5
    }
  ];

  // Filter the applicable tips based on the "applies" condition
  const applicableTips = tips.filter(tip => tip.applies);

  // Extract only the tip sentences into an array
  const tipsArray = applicableTips.map(tip => tip.sentence);

  // Join the tip sentences into a single string with a separator
  const tipsString = tipsArray.join(' ');


  // Calculate sleep score (this is just an example and NEEDS MORE WORK)

  if (wakeupCountInt === 2) {
    sleepScore = sleepScore - 10;
  }

  if (wakeupCountInt === 3) {
    sleepScore = sleepScore - 15;
  }

  if (wakeupCountInt === 4) {
    sleepScore = sleepScore - 20;
  }

  if (wakeupCountInt >= 5) {
    sleepScore = sleepScore - 25;
  }

  if (alcoholCount === 1) { 
    sleepScore = sleepScore - 10 
  }

  if (alcoholCount === 2) { 
    sleepScore = sleepScore - 15 
  }

  if (alcoholCount === 3) { 
    sleepScore = sleepScore - 20 
  }

  if (alcoholCount === 4) { 
    sleepScore = sleepScore - 25 
  }

  if (alcoholCount >= 5) { 
    sleepScore = sleepScore - 30 
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
    date: formattedDate, // use formatted date
    tips: tipsString // add the tips array as a string
  };

  // Save the report to the database
  try {
    const result = await reportCollection.insertOne(report);
    console.log(`Inserted report with ID ${result.insertedId}`);
    // Redirect the user to the newreport route with the report data in the query parameters, including the tips string
    res.redirect(`/newreport?sleepScore=${sleepScore}&bedtime=${bedtime}&wakeup=${wakeup}&wakeupCount=${wakeupCount}&alcohol=${alcohol}&alcoholCount=${alcoholCount}&tips=${encodeURIComponent(tipsString)}&date=${encodeURIComponent(formattedDate)}`);
  } catch (error) {
    console.error(error);
    res.status(500).send('Error submitting report');
  }
});

app.get('/newreport', sessionValidation, (req, res) => {
  const sleepScore = req.query.sleepScore;
  const bedtime = req.query.bedtime;
  const wakeup = req.query.wakeup;
  const wakeupCount = req.query.wakeupCount;
  const alcohol = req.query.alcohol;
  const alcoholCount = req.query.alcoholCount;
  const tipsString = req.query.tips;
  const date = req.query.date;

  // Split the tips string into an array of tips
  const tips = tipsString.split(/\.|\?|!/);

  // Render a new view with the report data
  res.render('newreport', { sleepScore, bedtime, wakeup, wakeupCount, alcohol, alcoholCount, tips, date });
});

//display sleepscore in main page
app.get("/main", sessionValidation, async (req, res) => {
  const name = req.session.name;

  const latestReport = await reportCollection.findOne({ userName: name }, { sort: { date: -1 } });
  console.log(latestReport);

  let sleepScore = "NA";
  if (latestReport !== null) {
    const { sleepScore: reportSleepScore } = latestReport;
    if (reportSleepScore !== null) {
      sleepScore = reportSleepScore;
    }
  }

  res.render("main", { name: name, sleepScore: sleepScore });
});

//for clicking on the button to see the latest report
app.post("/latestReport", sessionValidation, async (req, res) => {
  const name = req.session.name;
  const latestReport = await reportCollection.findOne({ userName: name }, { sort: { date: -1 } });
  console.log(latestReport);

  if (latestReport === null) {
    return res.send("<script>alert('You don\\'t have report! Let\\'s get your first report now!');window.location.href='/createreport'</script>");
  }

  const { sleepScore, bedtime, wakeup, wakeupCount, alcohol, alcoholCount, tips, date } = latestReport;
  const tipsString = encodeURIComponent(tips);
  const formattedDate = encodeURIComponent(date);

  res.redirect(`/newreport?sleepScore=${sleepScore}&bedtime=${bedtime}&wakeup=${wakeup}&wakeupCount=${wakeupCount}%20times&alcohol=${alcohol}&alcoholCount=${alcoholCount}&tips=${tipsString}&date=${formattedDate}`);
});


app.get("/about", (req, res) => {
  res.render("about");
});

app.get("/tips", sessionValidation, (req, res) => {
  res.render("tips");
});

//read the tips data
app.get('/tips-data', sessionValidation, function (req, res) {
  const tipsData = require('./app/data/tips.json');
  res.json(tipsData);
});

app.get('/settings', sessionValidation, function (req, res) {
  res.render("settings", { name: req.session.name });
})

app.get('/preferences', sessionValidation, function(req, res){
  res.render("preferences");
})

//get currentuser reports from mongodb
app.get('/report_list', sessionValidation, async (req, res) => {
  const name = req.session.name;
  const result = await reportCollection.find({ userName: name }).project({ userName: 1, date: 1, sleepScore: 1, _id: 1 }).toArray();
  console.log(result);
  res.render("report_list", { reports: result });
});

//to see the specific report by doc id 
app.post('/report_list/:id', sessionValidation, async (req, res) => {
  const reportId = req.params.id;
  const report = await reportCollection.findOne({ _id: new ObjectId(reportId) }, {
    projection: {
      bedtime: 1,
      wakeup: 1,
      wakeupCount: 1,
      alcohol: 1,
      alcoholCount: 1,
      tips: 1,
      userName: 1,
      date: 1,
      sleepScore: 1
    }
  });
  console.log(report);

  const { sleepScore, bedtime, wakeup, wakeupCount, alcohol, alcoholCount, tips, date } = report;
  const tipsString = encodeURIComponent(tips);
  const formattedDate = encodeURIComponent(date);

  res.redirect(`/newreport?sleepScore=${sleepScore}&bedtime=${bedtime}&wakeup=${wakeup}&wakeupCount=${wakeupCount}%20times&alcohol=${alcohol}&alcoholCount=${alcoholCount}&tips=${tipsString}&date=${formattedDate}`);
});

app.get("/problem",sessionValidation,(req, res) => {
  res.render("problem");
});

app.post('/reportProblem',sessionValidation, async(req, res) => {
  const name = req.session.name;
  const email = req.session.email;
  const problemText = req.body.problemText; // extract problem text from request body
  const date = new Date(); // get current date and time
  const report = {
    problemText: problemText,
    date: date,
    name:name,
    email:email
  };

  try {
    const result = await reportCollection.insertOne(report);
    console.log(`Inserted report `);
    
    res.send("<script>alert('Problem Reported succesfully');window.location.href='/problem'</script>")
  } catch (error) {
    console.error(error);
    res.status(500).send('Error submitting report');
  }
});

app.get("/stats", sessionValidation, async (req, res) => {
  const name = req.session.name;
  const reports = await reportCollection.find({ userName: name }).project({ userName: 1, date: 1, sleepScore: 1, _id: 0 }).toArray();
  const sleepScores = reports.map(report => report.sleepScore);
  const averageSleepScore = sleepScores.reduce((acc, score) => acc + score, 0) / sleepScores.length;

  // Check if the user has set a sleep score goal
  let sleepScoreGoal = req.session.sleepScoreGoal;
  if (!sleepScoreGoal) {
    sleepScoreGoal = '';
  }

  res.render("stats", { 
    name: name, 
    averageSleepScore: averageSleepScore,
    sleepScoreGoal: sleepScoreGoal,
    updatedSleepScoreGoal: req.query.sleepScoreGoal // Add the updated goal as a rendering variable
  });
});

// CURRENTLY -- breaks display of average sleep score if no input is provided when updating goal
app.post("/updateGoal", sessionValidation, (req, res) => {
  const name = req.session.name;
  const averageSleepScore = req.body.averageSleepScore;
  const sleepScoreGoal = req.body.goal; // Use "goal" instead of "sleepScoreGoal"

  // Check if the input is a valid number between 0 and 100 inclusive
  if (sleepScoreGoal !== '') {
    const sleepScoreGoalNumber = parseInt(sleepScoreGoal);
    if (!isNaN(sleepScoreGoalNumber) && sleepScoreGoalNumber >= 0 && sleepScoreGoalNumber <= 100) {
      req.session.sleepScoreGoal = sleepScoreGoalNumber;
      res.redirect("/stats?sleepScoreGoal=" + sleepScoreGoalNumber); // Add the updated goal as a query parameter in the URL
      return; // return early to prevent the subsequent res.render() call from executing
    }
  }

  // If the input is invalid or empty, render the stats page with the existing sleepScoreGoal
  res.render("stats", { name: name, averageSleepScore: averageSleepScore, sleepScoreGoal: req.session.sleepScoreGoal });
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