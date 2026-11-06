from flask import Flask, render_template, request, jsonify

app = Flask(__name__)

# Simulating our secure cloud database ledger
processed_signatures = set()
master_timeline = []


@app.route('/')
def home():
    # Renders the HTML interface and passes the current master timeline to it
    return render_template('index.html', timeline=master_timeline)


@app.route('/sync', methods=['POST'])
def sync_data():
    """Receives data packets from guards and deduplicates them"""
    global master_timeline
    incoming_batch = request.json
    duplicates_found = 0
    new_logs_added = 0

    for packet in incoming_batch:
        signature = (packet["device_id"], packet["sequence"])

        if signature in processed_signatures:
            duplicates_found += 1
            continue

        processed_signatures.add(signature)
        master_timeline.append(packet)
        new_logs_added += 1

    # Sort timeline by original hardware time
    master_timeline.sort(key=lambda x: x["timestamp"])

    return jsonify({
        "status": "success",
        "added": new_logs_added,
        "duplicates_ignored": duplicates_found
    })


if __name__ == '__main__':
    # Runs the local server on port 8080 to bypass network blockers
    app.run(debug=True, port=8080)
