import os
from flask import Flask, cli as flask_cli


def helper(x):
    return os.path.join(x, "a")


class Greeter:
    @staticmethod
    def make():
        return Greeter()

    def greet(self, name):
        return helper(name).upper()


@app.route("/x")
@login_required
def index():
    app.logger.info("hi")
    return render_template("x.html")
