import os
import sys
import json
import numpy as np
import collections
import Levenshtein
import shutil

class ClusteringOCR:
    def __init__(self, verbose=False):
        self.verbose = verbose

    def get_centroid(self, bbox):
        x_coords = [point[0] for point in bbox]
        y_coords = [point[1] for point in bbox]
        centroid_x = sum(x_coords) / len(x_coords)
        centroid_y = sum(y_coords) / len(y_coords)
        return (centroid_x, centroid_y)

    def distance_between_points(self, p1, p2):
        return ((p1[0] - p2[0]) ** 2 + (p1[1] - p2[1]) ** 2) ** 0.5

    def bbox_in_same_area(self, bbox1, bbox2, threshold=50):
        # Calculate the centroids of each bbox
        centroid1 = self.get_centroid(bbox1)
        centroid2 = self.get_centroid(bbox2)

        # Calculate the distance between the centroids
        distance = self.distance_between_points(centroid1, centroid2)

        # Check if the distance is less than the threshold
        return distance < threshold, distance

    def text_similarity(self, text1, text2):
        """
        This function will compute the similarity between two texts by comparing the number of common letters
        :param text1: first text
        :param text2: second text
        :return: similarity score between 0 and 1
        """
        text1 = text1.lower()
        text2 = text2.lower()
        common_letters = set(text1).intersection(set(text2))
        return len(common_letters) / max(len(text1), len(text2))

    def generate_stats_from_ocr_results(self, ocr_results):
        """
        This function will generate the stats used by the clustering from a list of ocr results
        Extracting the average bounding box, average text, and average confidence
        :param ocr_results: list of ocr results
        :return:
            average_bbox: average bounding box e.g [[345, 218], [580, 218], [580, 333], [345, 333]]
            std_bbox: standard deviation of the bounding box e.g {0: [0.1, 0.3], 1: [0.2, 0.0], 2: [0.1, 0.1], 3: [0.2, 0.2]}
            most_common_text_per_index: most common text at each index e.g {0: 'AMEL', 1: 'AT27C256R', 2: '70JU', 3: '2127'}
            text_frequency_per_index: text frequency at each index e.g {0: {'AMEL': 0.99, 'AS': 0.01}, 1: {'AT27C256R': 1}, 2: {'70JU': 1}, 3: {'2127': 1}}
            average_confidence: average OCR confidence at each index e.g {0: 0.99, 1: 0.70, 2: 0.01, 3: 0.99}
            most_frequent_number_word : the most frequent number of words in the ocr results
        """

        all_bbox = collections.defaultdict(list)
        outliers_num_words_count = 0
        all_text = collections.defaultdict(list)
        all_confidence = collections.defaultdict(list)

        # compute the most frerquent number of words
        number_words = [len(ocr_data) for ocr_data in ocr_results]
        most_frequent_number_word = collections.Counter(number_words).most_common(1)[0][
            0
        ]

        for ocr_data in ocr_results:
            if len(ocr_data) != most_frequent_number_word:
                outliers_num_words_count += 1
                continue
            for i, ocr_output in enumerate(ocr_data):
                bbox, text, confidence = ocr_output
                all_bbox[i].append(bbox)
                all_text[i].append(text)
                all_confidence[i].append(confidence)
        average_bbox = {k: np.mean(v, axis=0) for k, v in all_bbox.items()}
        std_bbox = {k: np.std(v, axis=0) for k, v in all_bbox.items()}
        most_common_text_per_index = {
            k: collections.Counter(v).most_common(1)[0][0] for k, v in all_text.items()
        }
        average_confidence = {k: np.mean(v) for k, v in all_confidence.items()}
        text_frequency_per_index = {
            k: collections.Counter(v) for k, v in all_text.items()
        }
        # normalize frequency
        for k, v in text_frequency_per_index.items():
            total = sum(v.values())
            for key, value in v.items():
                text_frequency_per_index[k][key] = value / total

        # if outliers_num_words_count is greater than 10% of the total number of images, then we print a warning

        if outliers_num_words_count > 0.1 * len(ocr_results):
            print(
                f"Warning: {outliers_num_words_count} images were removed from the clustering because they have a different number of words than the most common number of words"
            )

        return (
            average_bbox,
            std_bbox,
            most_common_text_per_index,
            text_frequency_per_index,
            average_confidence,
            most_frequent_number_word,
        )

    def run(self, ocr_results, image_names, reference_indexes=[], bbox_threshold=50):
        """
        This function will run the clustering pipeline on a list of ocr results
        :param ocr_results: list of ocr results
        :param image_name: name of the image
        :param reference_indexes: list of indexes to check for anomalies
        :param bbox_threshold: threshold for the bbox clustering
        :return: list of anomalies in the format (image_name, []anomalies) where anomalies is a dictionary with the following, optional, keys:
            anomaly_name: name of the anomaly
            index: index of the anomaly
            confidence: confidence of the anomaly
            text: text of the anomaly
            reference_text: reference text
        """

        indexes_with_anomalies = (
            []
        )  # list of indexes with anomalies with the reason code e.g [(1, "different_subtext"), (3, "different_bbox")]
        (
            average_bbox,
            std_bbox,
            most_common_text_per_index,
            text_frequency_per_index,
            average_confidence,
            most_frequent_number_word,
        ) = self.generate_stats_from_ocr_results(ocr_results)

        if len(reference_indexes) == 0:
            reference_indexes = list(range(most_frequent_number_word))

        for i in range(len(ocr_results)):
            ocr_data = ocr_results[i]

            if len(ocr_data) != most_frequent_number_word:
                indexes_with_anomalies.append(
                    (i, {"anomaly_name": "erroneous_number_of_words"})
                )
                continue

            for index_to_check in reference_indexes:
                ocr_output = ocr_data[index_to_check]
                bbox, text, confidence = ocr_output

                same_text = text == most_common_text_per_index[index_to_check]
                if not same_text:
                    indexes_with_anomalies.append(
                        (
                            i,
                            {
                                "anomaly_name": "erroneous_text",
                                "index": index_to_check,
                                "confidence": (
                                    1 - text_frequency_per_index[index_to_check][text]
                                )
                                * (
                                    1
                                    - self.text_similarity(
                                        text, most_common_text_per_index[index_to_check]
                                    )
                                ),
                                "text": text,
                                "reference_text": most_common_text_per_index[
                                    index_to_check
                                ],
                            },
                        )
                    )

                same_area, distance = self.bbox_in_same_area(
                    bbox, average_bbox[index_to_check], threshold=bbox_threshold
                )
                if not same_area:
                    indexes_with_anomalies.append(
                        (
                            i,
                            {
                                "anomaly_name": "erroneous_bbox",
                                "index": index_to_check,
                                "confidence": 1 - bbox_threshold / distance,
                            },
                        )
                    )

        # building the final output by concatenating the different anomalies for each image

        final_output = []
        for i in range(len(ocr_results)):
            ocr_data = ocr_results[i]
            image_name = image_names[i]
            anomalies = [
                anomaly for anomaly in indexes_with_anomalies if anomaly[0] == i
            ]
            if len(anomalies) > 0:
                final_output.append((image_name, anomalies))
        return most_common_text_per_index, final_output


def combine_string_from_dict(dictionary):
    return "".join(dictionary.values()).replace(" ", "")


def combine_string_from_array(array):
    return "".join(array).replace(" ", "")


def is_similar(string1, string2):
    # levenshtein distance: the minimum number of single-character edits
    distance = Levenshtein.distance(string1, string2)
    similarity = 1 - (distance / max(len(string1), len(string2)))
    return similarity >= 0.8


def move_files(file_paths, destination_directory):
    new_file_paths = []
    for file_path in file_paths:
        file_name = os.path.basename(file_path)
        destination_path = os.path.join(destination_directory, file_name)
        new_file_paths.append(destination_path)
        shutil.move(file_path, destination_path)
    return destination_path

def convert_vision_ai_output(vision_ai_responses):
    output = []
    for res in vision_ai_responses:
        for item in res:
            bounding_boxs = item['textAnnotations']
            if bounding_boxs != None and len(bounding_boxs) > 0 and 'locale' in bounding_boxs[0]:
                bounding_boxs = bounding_boxs[1:]
            converted_format = [(list(map(lambda v: [v['x'], v['y']], bb['boundingPoly']['vertices'])),
                    bb['description'],
                    1.0) for bb in bounding_boxs]
            output.append(converted_format)
    return output

has_error = False
saved_exception = None
clustered_set = set()
anomaly_set = set()
path_id_map = {}

# Iterate over the sorted image files
try:
    IS_PATH_LOCAL = True
    VERBOSE = False
    BBOX_DISTANCE_THRESHOLD = 50
    # Read the object from standard input
    json_file_name = sys.argv[1]

    with open(json_file_name) as file:
        data = json.load(file)
    # Parse the JSON string back into a Python object
    ocr_results = convert_vision_ai_output(data['visionAiResponses'])
    paths = data['filePaths']
    ids = data['ids']
    for i in range(len(paths)):
        path_id_map[paths[i]] = ids[i]
    # Instancating the OCR clustering
    clustering_ocr = ClusteringOCR(verbose=True)

    # Running the clustering
    most_common_text_per_index, clustering_output = clustering_ocr.run(
        ocr_results, paths, reference_indexes=[], bbox_threshold=BBOX_DISTANCE_THRESHOLD
    )

    #  Displaying the result
    reference_string = combine_string_from_dict(most_common_text_per_index)

    for cluster_res in clustering_output:
        image_name, anomalies = cluster_res
        ind = anomalies[0][0]
        ocr_text = []
        for k in range(len(ocr_results[ind])):
            bbox, ocr, confidence = ocr_results[ind][k]
            ocr_text.append(ocr)
        if len(ocr_text) == 0:
            anomaly_set.add(image_name)
            continue
        extracted_str = combine_string_from_array(ocr_text)
        if not is_similar(reference_string, extracted_str):
            anomaly_set.add(image_name)
            continue
        clustered_set.add(image_name)
except Exception as e:
    has_error = True
    saved_exception = e
    pass

# TODO: handle more logic here and think about how we can cluster it together, and what response we want from this API
output = {
    "clusteredImages": [{"id": path_id_map[i], "path": i} for i in list(clustered_set)],
    "anomalyImages": [{"id": path_id_map[i], "path": i} for i in list(anomaly_set)],
    "hasError": has_error,
}
print(json.dumps(output))
if has_error:
    raise saved_exception